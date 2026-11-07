import { useMemo } from "react";
import type * as Y from "yjs";
import { setSheetName } from "@worksheet-clone/shared";
import { LOCAL_ORIGIN } from "./origin";
import { useWorkbookDoc } from "./WorkbookDoc";

// The only code allowed to write to the Y.Doc. Each user action is exactly
// one transaction tagged LOCAL_ORIGIN, so it syncs atomically and undoes as a
// single step.
//
// Writes are refused while read-only: the server would drop them, but the
// local replica would keep them and silently diverge (see failure-log.md).
function transact(doc: Y.Doc, readOnly: boolean, change: () => void): boolean {
  if (readOnly) {
    return false;
  }
  doc.transact(change, LOCAL_ORIGIN);
  return true;
}

export function renameSheet(doc: Y.Doc, readOnly: boolean, sheetId: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }
  return transact(doc, readOnly, () => setSheetName(doc, sheetId, trimmed));
}

export function useWorkbookMutations() {
  const { doc, readOnly } = useWorkbookDoc();
  return useMemo(
    () => ({
      renameSheet: (sheetId: string, name: string) => renameSheet(doc, readOnly, sheetId, name),
    }),
    [doc, readOnly],
  );
}
