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
 * TODO(M7): placeholder until the insert/delete helpers are wired in. Menu items and shortcuts
 * call it, so they are visible and testable but change nothing.
 */
export const unimplementedStructureActions: StructureActions = {
  insertRows() {},
  insertCols() {},
  deleteRows() {},
  deleteCols() {},
};
