import { HocuspocusProvider } from "@hocuspocus/provider";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useDispatch, useSelector } from "react-redux";
import * as Y from "yjs";
import type { RootState } from "../app/store";
import { collabActions } from "./collabSlice";

interface WorkbookDocValue {
  doc: Y.Doc;
  /** True until the server has confirmed read-write access. */
  readOnly: boolean;
}

const WorkbookDocContext = createContext<WorkbookDocValue | null>(null);

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
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const access = useSelector((state: RootState) => state.collab.access);

  useEffect(() => {
    const ydoc = new Y.Doc();
    dispatch(collabActions.opened(workbookId));

    const provider = new HocuspocusProvider({
      url: collabUrl(window.location),
      name: workbookId,
      document: ydoc,
      onStatus: ({ status }) => dispatch(collabActions.statusChanged(status)),
      onSynced: ({ state }) => dispatch(collabActions.syncedChanged(state)),
      onAuthenticated: ({ scope }) =>
        dispatch(collabActions.accessChanged(scope === "read-write" ? "read-write" : "read-only")),
      onAuthenticationFailed: () => dispatch(collabActions.accessChanged("denied")),
    });
    setDoc(ydoc);

    return () => {
      provider.destroy();
      ydoc.destroy();
      setDoc(null);
      dispatch(collabActions.closed());
    };
  }, [workbookId, dispatch]);

  if (!doc) {
    return null;
  }
  return (
    <WorkbookDocContext.Provider value={{ doc, readOnly: access !== "read-write" }}>
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
