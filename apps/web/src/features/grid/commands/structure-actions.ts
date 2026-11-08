import type * as Y from "yjs";
import { MAX_COL_COUNT, MAX_ROW_COUNT, readColOrder, readRowOrder } from "@worksheet-clone/shared";
import type { AppDispatch } from "../../../app/store";
import {
  deleteCols,
  deleteRows,
  insertCols,
  insertRows,
  type StructureResult,
} from "../../../crdt/mutations";
import { toastsActions } from "../../toasts/toastsSlice";
import { gridActions } from "../gridSlice";

/**
 * Row/column structure edits the context menu and the Ctrl+Alt+= / Ctrl+Alt+- shortcuts ask
 * for. The grid only decides WHAT (which rows/columns, how many, where); the implementation
 * lives elsewhere (shared insert/delete helpers, one Y.Doc transaction each) and is injected
 * through `GridContainer`'s `structure` prop, so this layer never touches the order arrays.
 *
 * Indices are visual (current screen order). Callers have already refused viewers; an
 * implementation must still use the `crdt/` mutation layer, which refuses read-only writes.
 */
export interface StructureActions {
  /** Inserts `count` empty rows so that the first new row ends up at visual index `at`. */
  insertRows(at: number, count: number): void;
  /** Inserts `count` empty columns so that the first new column ends up at visual index `at`. */
  insertCols(at: number, count: number): void;
  /** Deletes the rows with these ids (stable ids, so a concurrent insert cannot shift the target). */
  deleteRows(rowIds: readonly string[]): void;
  /** Deletes the columns with these ids. */
  deleteCols(colIds: readonly string[]): void;
}

/**
 * No-op implementation for tests that only check what the grid asks for (the controller's
 * default). The app uses {@link createStructureActions}.
 */
export const unimplementedStructureActions: StructureActions = {
  insertRows() {},
  insertCols() {},
  deleteRows() {},
  deleteCols() {},
};

export interface StructureActionsDeps {
  doc: Y.Doc;
  sheetId: string;
  /** Read on every action so a revoked edit right applies live. */
  isReadOnly(): boolean;
  dispatch: AppDispatch;
}

const ROW_LIMIT = `A sheet can have at most ${MAX_ROW_COUNT.toLocaleString("en-US")} rows`;
const COL_LIMIT = `A sheet can have at most ${MAX_COL_COUNT.toLocaleString("en-US")} columns`;

/**
 * The real implementation: each action is one LOCAL_ORIGIN transaction through `crdt/mutations`
 * (so one undo step), then selects the affected whole rows/columns like Google Sheets: the new
 * ones after an insert, the row/column that took the first deleted position after a delete.
 */
export function createStructureActions(deps: StructureActionsDeps): StructureActions {
  const { doc, sheetId, dispatch } = deps;

  const selectRows = (from: string, to: string) => {
    const cols = readColOrder(doc, sheetId);
    const first = cols[0];
    const last = cols[cols.length - 1];
    if (first === undefined || last === undefined) return;
    dispatch(
      gridActions.selectionChanged({
        anchor: { rowId: from, colId: first },
        focus: { rowId: to, colId: last },
      }),
    );
  };
  const selectCols = (from: string, to: string) => {
    const rows = readRowOrder(doc, sheetId);
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first === undefined || last === undefined) return;
    dispatch(
      gridActions.selectionChanged({
        anchor: { rowId: first, colId: from },
        focus: { rowId: last, colId: to },
      }),
    );
  };
  const refuse = (result: StructureResult, limitMessage: string) => {
    if (!result.ok && result.reason === "limit") dispatch(toastsActions.pushed(limitMessage));
  };

  return {
    insertRows(at, count) {
      const result = insertRows(doc, deps.isReadOnly(), sheetId, at, count);
      if (result.ok) selectRows(result.ids[0]!, result.ids[result.ids.length - 1]!);
      else refuse(result, ROW_LIMIT);
    },
    insertCols(at, count) {
      const result = insertCols(doc, deps.isReadOnly(), sheetId, at, count);
      if (result.ok) selectCols(result.ids[0]!, result.ids[result.ids.length - 1]!);
      else refuse(result, COL_LIMIT);
    },
    deleteRows(rowIds) {
      const before = readRowOrder(doc, sheetId);
      const gone = new Set(rowIds);
      const first = before.findIndex((id) => gone.has(id));
      const result = deleteRows(doc, deps.isReadOnly(), sheetId, rowIds);
      if (!result.ok || first === -1) return;
      const after = readRowOrder(doc, sheetId);
      const id = after[Math.min(first, after.length - 1)];
      if (id !== undefined) selectRows(id, id);
    },
    deleteCols(colIds) {
      const before = readColOrder(doc, sheetId);
      const gone = new Set(colIds);
      const first = before.findIndex((id) => gone.has(id));
      const result = deleteCols(doc, deps.isReadOnly(), sheetId, colIds);
      if (!result.ok || first === -1) return;
      const after = readColOrder(doc, sheetId);
      const id = after[Math.min(first, after.length - 1)];
      if (id !== undefined) selectCols(id, id);
    },
  };
}
