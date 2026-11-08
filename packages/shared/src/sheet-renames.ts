import type * as Y from "yjs";
import { getSheetName, readSheetOrder } from "./doc-schema.js";

// Pure helpers behind the "X renamed sheet A to B" notices. Shared so the
// server and the hermetic e2e fake server produce identical notices.

/** sheetId -> name */
export type SheetNames = ReadonlyMap<string, string>;

export interface SheetRename {
  sheetId: string;
  from: string;
  to: string;
}

export function readSheetNames(doc: Y.Doc): Map<string, string> {
  const names = new Map<string, string>();
  for (const sheetId of readSheetOrder(doc)) {
    const name = getSheetName(doc, sheetId);
    if (name !== undefined) {
      names.set(sheetId, name);
    }
  }
  return names;
}

/** Sheets present in both snapshots whose name differs. Additions and deletions are not renames. */
export function diffSheetNames(before: SheetNames, after: SheetNames): SheetRename[] {
  const renames: SheetRename[] = [];
  for (const [sheetId, to] of after) {
    const from = before.get(sheetId);
    if (from !== undefined && from !== to) {
      renames.push({ sheetId, from, to });
    }
  }
  return renames;
}
