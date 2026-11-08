import { HocuspocusProvider } from "@hocuspocus/provider";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useDispatch, useSelector, useStore } from "react-redux";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { AppDispatch, RootState } from "../app/store";
import { handleCollabNotice } from "./handleCollabNotice";
import { authApi } from "../features/auth/authApi";
import { workbooksApi } from "../features/workbooks/workbooksApi";
import {
  confirmDeniedKind,
  deniedKindFromCloseReason,
  DirtyTracker,
  type WorkbookLookup,
} from "./accessLoss";
import { collabActions } from "./collabSlice";
import { clearWorkbookCache, openOfflineCache } from "./offlineCache";
import { captureUndoContext, createWorkbookUndo, type WorkbookUndo } from "./undo";

interface WorkbookDocValue {
  doc: Y.Doc;
  /** True until the server has confirmed read-write access. */
  readOnly: boolean;
  /** This user's undo history for the doc (absent only in tests that don't need it). */
  undo?: WorkbookUndo;
  /**
   * Throws this replica away (doc, provider, on-device copy) and mounts a fresh one from the
   * server. Used after access dropped while local changes were unconfirmed. Absent in tests.
   */
  resetDoc?: () => Promise<void>;
  /** The provider's presence channel (absent in tests that don't need it). */
  awareness?: Awareness | null;
}

export const WorkbookDocContext = createContext<WorkbookDocValue | null>(null);

export function collabUrl(location: Pick<Location, "protocol" | "host">): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;
}

/**
 * Owns one workbook's Y.Doc and its connection for as long as it's mounted:
 * opening a workbook connects, leaving it (or switching) destroys both.
 */
export function WorkbookDocProvider({
  workbookId,
  children,
}: {
  workbookId: string;
  children: ReactNode;
}) {
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  const [open, setOpen] = useState<{
    doc: Y.Doc;
    undo: WorkbookUndo;
    awareness: Awareness | null;
  } | null>(null);
  // Bumped by resetDoc: the effect below re-runs and builds a brand-new doc and provider.
  const [epoch, setEpoch] = useState(0);
  const resetRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const access = useSelector((state: RootState) => state.collab.access);
  // The undo manager reads access when you press undo, not when it was created.
  const readOnlyRef = useRef(true);
  readOnlyRef.current = access !== "read-write";

  useEffect(() => {
    const ydoc = new Y.Doc();
    const undo = createWorkbookUndo(ydoc, {
      isReadOnly: () => readOnlyRef.current,
      getContext: () => captureUndoContext(ydoc, store.getState().grid),
    });
    dispatch(collabActions.opened(workbookId));
    dispatch(collabActions.onlineChanged(navigator.onLine));
    const onOnline = () => dispatch(collabActions.onlineChanged(true));
    const onOffline = () => dispatch(collabActions.onlineChanged(false));
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    // The user comes from the /me cache: this provider only mounts after REST confirmed membership.
    // The cache is applied with its own origin (not LOCAL_ORIGIN), so undo never records it, and
    // the provider forwards it to the server like any other local change.
    const userId = authApi.endpoints.me.select()(store.getState()).data?.user.id;
    const cache = userId ? openOfflineCache(ydoc, userId, workbookId) : null;
    const tracker = new DirtyTracker();
    let lastCloseReason: string | undefined;
    // Stops persisting and wipes the on-device copy: used when the user may no longer keep this
    // workbook (removed, deleted) or when its unsent edits must not come back after a reload.
    const wipeCache = async () => {
      await cache?.destroy();
      if (userId) await clearWorkbookCache(userId, workbookId);
    };
    let unmounted = false;
    void cache?.whenLoaded.then(() => {
      if (!unmounted) dispatch(collabActions.cacheLoaded());
    });

    const provider = new HocuspocusProvider({
      url: collabUrl(window.location),
      name: workbookId,
      document: ydoc,
      onStatus: ({ status }) => dispatch(collabActions.statusChanged(status)),
      onSynced: ({ state }) => dispatch(collabActions.syncedChanged(state)),
      onUnsyncedChanges: ({ number }) => {
        dispatch(collabActions.unsyncedChangesChanged(number));
        tracker.noteUnsynced(number);
        // The server confirmed everything after all (the acknowledgement was just late).
        const loss = store.getState().collab.accessLoss;
        if (loss?.kind === "downgraded" && loss.unsaved && !tracker.unsaved) {
          dispatch(collabActions.accessLost({ kind: "downgraded", unsaved: false }));
        }
      },
      onClose: ({ event }) => {
        lastCloseReason = event?.reason;
      },
      onAuthenticated: ({ scope }) => {
        const next = scope === "read-write" ? "read-write" : "read-only";
        const wasEditor = store.getState().collab.access === "read-write";
        if (next === "read-write") {
          dispatch(collabActions.accessLossCleared());
        } else if (wasEditor) {
          // Downgraded mid-session. A viewer cannot write, so a replica that held only confirmed
          // changes equals the server and needs no reset. Unconfirmed ones will be dropped by the
          // server and would linger here forever: offer them, and stop the cache from reviving them.
          dispatch(collabActions.accessLost({ kind: "downgraded", unsaved: tracker.unsaved }));
          if (tracker.unsaved) void wipeCache();
        }
        dispatch(collabActions.accessChanged(next));
      },
      onAuthenticationFailed: () => {
        dispatch(collabActions.accessChanged("denied"));
        const guess = deniedKindFromCloseReason(lastCloseReason);
        const unsaved = tracker.unsaved;
        dispatch(collabActions.accessLost({ kind: guess, unsaved }));
        void wipeCache();
        void lookUpWorkbook(dispatch, workbookId).then((lookup) => {
          const kind = confirmDeniedKind(guess, lookup);
          if (!unmounted && kind !== guess) dispatch(collabActions.accessLost({ kind, unsaved }));
        });
      },
      onStateless: ({ payload }) =>
        handleCollabNotice(payload, {
          workbookId,
          dispatch,
          currentUserId: () => authApi.endpoints.me.select()(store.getState()).data?.user.id,
        }),
    });
    // Anything that did not come from the server (typing, the on-device copy) is unconfirmed.
    const onDocUpdate = (_update: Uint8Array, origin: unknown) =>
      tracker.noteUpdate(origin, provider);
    ydoc.on("update", onDocUpdate);
    setOpen({ doc: ydoc, undo, awareness: provider.awareness });

    let disposed = false;
    const disposeConnection = async () => {
      if (disposed) return;
      disposed = true;
      provider.destroy();
      await cache?.destroy();
    };
    let resetting = false;
    resetRef.current = async () => {
      if (resetting) return;
      resetting = true;
      await disposeConnection();
      await wipeCache();
      setEpoch((n) => n + 1);
    };

    return () => {
      ydoc.off("update", onDocUpdate);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      unmounted = true;
      void disposeConnection();
      undo.destroy();
      ydoc.destroy();
      setOpen(null);
      dispatch(collabActions.closed());
    };
  }, [workbookId, epoch, dispatch, store]);

  if (!open) {
    return null;
  }
  return (
    <WorkbookDocContext.Provider
      value={{
        doc: open.doc,
        undo: open.undo,
        awareness: open.awareness,
        readOnly: access !== "read-write",
        resetDoc: () => resetRef.current(),
      }}
    >
      {children}
    </WorkbookDocContext.Provider>
  );
}

export function useWorkbookDoc(): WorkbookDocValue {
  const value = useContext(WorkbookDocContext);
  if (!value) {
    throw new Error("useWorkbookDoc must be used inside <WorkbookDocProvider>");
  }
  return value;
}

/** Asks REST whether the workbook is still readable by this user (a plain read, no page query touched). */
async function lookUpWorkbook(dispatch: AppDispatch, workbookId: string): Promise<WorkbookLookup> {
  const result = await dispatch(
    workbooksApi.endpoints.getWorkbook.initiate(workbookId, {
      forceRefetch: true,
      subscribe: false,
    }),
  );
  if (!result.isError) return "found";
  return (result.error as { status?: unknown } | undefined)?.status === 404 ? "missing" : "failed";
}
