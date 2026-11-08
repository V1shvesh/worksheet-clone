import { HocuspocusProvider } from "@hocuspocus/provider";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useDispatch, useSelector, useStore } from "react-redux";
import * as Y from "yjs";
import type { RootState } from "../app/store";
import { handleCollabNotice } from "./handleCollabNotice";
import { authApi } from "../features/auth/authApi";
import { collabActions } from "./collabSlice";
import { openOfflineCache } from "./offlineCache";
import { captureUndoContext, createWorkbookUndo, type WorkbookUndo } from "./undo";

interface WorkbookDocValue {
  doc: Y.Doc;
  /** True until the server has confirmed read-write access. */
  readOnly: boolean;
  /** This user's undo history for the doc (absent only in tests that don't need it). */
  undo?: WorkbookUndo;
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
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  const [open, setOpen] = useState<{ doc: Y.Doc; undo: WorkbookUndo } | null>(null);
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
      onUnsyncedChanges: ({ number }) => dispatch(collabActions.unsyncedChangesChanged(number)),
      onAuthenticated: ({ scope }) =>
        dispatch(collabActions.accessChanged(scope === "read-write" ? "read-write" : "read-only")),
      onAuthenticationFailed: () => dispatch(collabActions.accessChanged("denied")),
      onStateless: ({ payload }) =>
        handleCollabNotice(payload, {
          workbookId,
          dispatch,
          currentUserId: () => authApi.endpoints.me.select()(store.getState()).data?.user.id,
        }),
    });
    setOpen({ doc: ydoc, undo });

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      unmounted = true;
      provider.destroy();
      void cache?.destroy();
      undo.destroy();
      ydoc.destroy();
      setOpen(null);
      dispatch(collabActions.closed());
    };
  }, [workbookId, dispatch, store]);

  if (!open) {
    return null;
  }
  return (
    <WorkbookDocContext.Provider
      value={{ doc: open.doc, undo: open.undo, readOnly: access !== "read-write" }}
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
