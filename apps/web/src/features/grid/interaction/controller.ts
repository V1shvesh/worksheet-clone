import type * as Y from "yjs";
import { readColOrder, readRowOrder } from "@worksheet-clone/shared";
import type { AppDispatch, RootState } from "../../../app/store";
import { setColWidth, setRowHeight } from "../../../crdt/mutations";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { toastsActions } from "../../toasts/toastsSlice";
import { fillRange } from "../commands/fill-range";
import { moveCells, pasteEntries } from "../commands/paste";
import { setCellInput } from "../commands/set-cell-input";
import { clipboardActions } from "../clipboardSlice";
import { clearRange } from "../commands/clear-range";
import {
  unimplementedStructureActions,
  type StructureActions,
} from "../commands/structure-actions";
import { toggleFormat } from "../commands/format-selection";
import { gridActions } from "../gridSlice";
import {
  isHeaderHit,
  coordsEqual,
  normalizeRange,
  type CellCoord,
  type CellRange,
  type CellRenderData,
  type GridDimensions,
  type GridView,
} from "../port";
import {
  buildCopy,
  MAX_PASTE_CELLS,
  planPaste,
  type ClipboardDataLike,
  type PasteSource,
} from "./clipboard";
import { parseClipboardHtml } from "./clipboard-html";
import { fillExtent, fillPointer, type FillExtent } from "./fill";
import { buildMenu, structureShortcut, type MenuAction, type MenuItem } from "./context-menu";
import { parseTsv } from "./tsv";
import {
  cancelEditing,
  commitEditing,
  reduceKey,
  type Direction,
  type GridCommand,
  type KeyboardEnv,
  type KeyboardResult,
  type KeyboardState,
} from "./keyboard";
import {
  contextMenuSelection,
  initialPointerState,
  pointerDown,
  pointerMove,
  pointerUp,
  type PointerContext,
  type PointerResult,
  type PointerState,
} from "./pointer";
import {
  cellIdAt,
  idSelectionsEqual,
  resolveSelection,
  toIdSelection,
  type IdMapper,
  type IndexSelection,
} from "./selection";

export interface GridStore {
  dispatch: AppDispatch;
  getState: () => Pick<RootState, "grid" | "clipboard">;
}

/** What the controller reads from the view model (SheetViewModel satisfies this). */
export interface InteractionModel extends IdMapper {
  /** Full geometry; the controller re-sends it when a resize is refused. */
  dimensions(): GridDimensions;
  getRawInput(cell: CellCoord): string;
  getCell(cell: CellCoord): CellRenderData;
}

export interface GridInteractionDeps {
  view: GridView;
  model: InteractionModel;
  store: GridStore;
  /**
   * `readOnly` is read on every action, so pass an object with a getter if access
   * can change while the sheet is open.
   */
  target: { doc: Y.Doc; readOnly: boolean };
  sheetId: string;
  /** Undo/redo for Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Ctrl+Y; the callee restores sheet and selection. */
  history?: { undo(): void; redo(): void };
  /**
   * Insert/delete rows and columns, for the context menu and Ctrl+Alt+= / Ctrl+Alt+-. Defaults to
   * a no-op placeholder (`unimplementedStructureActions`).
   */
  structure?: StructureActions;
}

/** The fill-handle drag, driven by the overlay's pointer events (client coordinates). */
export interface FillDrag {
  /** Starts a drag from the current selection; false when read-only, editing or nothing selected. */
  begin(): boolean;
  /** Follows the pointer and updates `grid.fillPreview`. Positions outside the grid keep the last result. */
  move(clientX: number, clientY: number): void;
  /** Fills (if the pointer ended outside the selection) in one transaction, then selects source + fill. */
  end(clientX: number, clientY: number): void;
  /** Abandons the drag without writing (Escape, pointer cancel). */
  cancel(): void;
}

export interface GridInteraction {
  fill: FillDrag;
  /** Commit the current edit (the overlay editor's Enter/Tab/blur); no-op if not editing. */
  commitEdit(draft: string, move: Direction | null): void;
  /** Discard the current edit (Esc); no-op if not editing. */
  cancelEdit(): void;
  /**
   * Opens an edit of the active cell (selection anchor) from its raw input; false when
   * read-only, nothing is selected, or an edit is already open. The formula bar uses this.
   */
  startEdit(source: "bar"): boolean;
  /**
   * Native copy/cut: writes text/plain (displayed values as TSV) and text/html (our payload)
   * into `data`. Returns true when handled, so the caller can preventDefault; false when
   * nothing is selected or a cell is being edited (native text copy must keep working).
   */
  copy(data: ClipboardDataLike, cut: boolean): boolean;
  /** Native paste; same return contract as `copy`. Refused (but handled) while read-only. */
  paste(data: ClipboardDataLike): boolean;
  /**
   * Row-height drag from the overlay's resize handle, called directly (AG Grid has no row
   * resize, so the port's `rowResized` is not involved). One transaction; false when refused.
   */
  resizeRow(row: number, height: number): boolean;
  /** The context menu's items for the current selection (empty when nothing is selected). */
  menuItems(): MenuItem[];
  /** Runs a menu action; refused (no-op) for viewers and for disabled actions. */
  runMenuAction(action: MenuAction): void;
  /** Keep the Redux draft in sync with the overlay editor's text. */
  updateDraft(text: string): void;
  dispose(): void;
}

/**
 * Wires GridView events to the interaction state machines and Redux. Plain TS:
 * the overlay and container call into this, the grid never does.
 */
function idsBetween(from: number, to: number, idAt: (i: number) => string | undefined): string[] {
  const ids: string[] = [];
  for (let i = from; i <= to; i++) {
    const id = idAt(i);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

export function createGridInteraction(deps: GridInteractionDeps): GridInteraction {
  const { view, model, store, target, sheetId, history } = deps;
  const structure = deps.structure ?? unimplementedStructureActions;
  let pointer: PointerState = initialPointerState;

  store.dispatch(gridActions.sheetOpened(sheetId));

  const pointerContext = (): PointerContext => {
    const resolved = resolveSelection(store.getState().grid.selection, model);
    const { rowCount, colCount } = model.dimensions();
    return {
      selection: resolved && { anchor: resolved.anchor, focus: resolved.focus },
      rowCount,
      colCount,
    };
  };

  const select = (selection: IndexSelection) => {
    const next = toIdSelection(selection, model);
    if (!next || idSelectionsEqual(next, store.getState().grid.selection)) return;
    store.dispatch(gridActions.selectionChanged(next));
  };

  const applyPointer = (result: PointerResult) => {
    pointer = result.state;
    if (result.selection) select(result.selection);
  };

  const env = (): KeyboardEnv => ({
    ...model.dimensions(),
    readOnly: target.readOnly,
    getRawInput: (cell) => model.getRawInput(cell),
  });

  const keyboardState = (): KeyboardState => {
    const grid = store.getState().grid;
    const resolved = resolveSelection(grid.selection, model);
    const selection = resolved && { anchor: resolved.anchor, focus: resolved.focus };
    const e = grid.editing;
    if (!e) return { selection, editing: null };
    const row = model.rowIndexOf(e.rowId);
    const col = model.colIndexOf(e.colId);
    if (row === undefined || col === undefined) {
      // The edited cell was deleted by a collaborator; there is nothing to commit to.
      store.dispatch(gridActions.editingEnded());
      return { selection, editing: null };
    }
    return { selection, editing: { cell: { row, col }, draft: e.draft, mode: e.mode } };
  };

  const runMenuAction = (action: MenuAction) => {
    if (target.readOnly) return;
    switch (action.type) {
      case "insertRows":
        structure.insertRows(action.at, action.count);
        break;
      case "insertCols":
        structure.insertCols(action.at, action.count);
        break;
      case "deleteRows": {
        // Deleting every row would leave no sheet to edit (the menu disables it, too).
        if (action.to - action.from + 1 >= model.dimensions().rowCount) break;
        const ids = idsBetween(action.from, action.to, (i) => model.rowIdAt(i));
        if (ids.length > 0) structure.deleteRows(ids);
        break;
      }
      case "deleteCols": {
        if (action.to - action.from + 1 >= model.dimensions().colCount) break;
        const ids = idsBetween(action.from, action.to, (j) => model.colIdAt(j));
        if (ids.length > 0) structure.deleteCols(ids);
        break;
      }
      case "clear":
        clearRange(target, sheetId, action.range, model);
        break;
    }
  };

  const run = (command: GridCommand) => {
    switch (command.type) {
      case "setCellInput":
        setCellInput(target, sheetId, command.cell, command.raw);
        break;
      case "clearRange":
        clearRange(target, sheetId, command.range, model);
        break;
      case "toggleFormat": {
        const selection = store.getState().grid.selection;
        if (selection) toggleFormat(target, sheetId, selection, command.flag);
        break;
      }
      case "structure": {
        const resolved = resolveSelection(store.getState().grid.selection, model);
        const action =
          resolved &&
          structureShortcut(command.op, resolved.range, model.dimensions(), target.readOnly);
        if (action) runMenuAction(action);
        break;
      }
      case "undo":
      case "redo": {
        history?.[command.type]();
        view.focus();
        // Scroll the ACTIVE cell (the anchor) into view, minimally, like Google Sheets. The
        // focus corner is wrong here: for a whole-column selection it is the last row, so
        // undoing a column action would jump the viewport to the bottom of the sheet.
        const restored = resolveSelection(store.getState().grid.selection, model);
        if (restored) view.scrollIntoView(restored.anchor);
        break;
      }
    }
  };

  /** Pushes a reducer result into Redux, runs its commands, and follows the focus. */
  const apply = (prev: KeyboardState, result: KeyboardResult) => {
    for (const command of result.commands) run(command);
    const next = result.state;

    if (next.selection !== prev.selection && next.selection) select(next.selection);
    if (prev.editing && !next.editing) {
      store.dispatch(gridActions.editingEnded());
    } else if (!prev.editing && next.editing) {
      const id = cellIdAt(next.editing.cell, model);
      if (id) {
        store.dispatch(
          gridActions.editingStarted({ ...id, draft: next.editing.draft, mode: next.editing.mode }),
        );
      }
    }

    const before = prev.selection?.focus;
    const after = next.selection?.focus;
    if (after && (!before || !coordsEqual(before, after))) view.scrollIntoView(after);
  };

  const commitEdit = (draft: string, move: Direction | null) => {
    const prev = keyboardState();
    if (!prev.editing) return;
    apply(prev, commitEditing(prev, draft, move, env()));
  };

  const clearCutMark = () => {
    if (store.getState().clipboard.cutMark) store.dispatch(clipboardActions.cutCleared());
  };
  const toast = (message: string) => store.dispatch(toastsActions.pushed(message));

  /** Any edit by this user abandons a pending cut (the move writes only after checking it). */
  const onTransaction = (tr: Y.Transaction) => {
    if (tr.origin === LOCAL_ORIGIN && tr.changed.size > 0) clearCutMark();
  };
  target.doc.on("afterTransaction", onTransaction);

  const copy = (data: ClipboardDataLike, cut: boolean): boolean => {
    const state = store.getState().grid;
    if (state.editing) return false;
    const resolved = resolveSelection(state.selection, model);
    if (!resolved) return false;
    if (cut && target.readOnly) return true;
    const { text, html } = buildCopy(model, sheetId, resolved.range, cut);
    data.setData("text/plain", text);
    data.setData("text/html", html);
    if (cut) {
      const { start, end } = resolved.range;
      const from = cellIdAt(start, model);
      const to = cellIdAt(end, model);
      if (from && to) {
        store.dispatch(clipboardActions.cutMarked({ sheetId, range: { anchor: from, focus: to } }));
      }
    } else {
      clearCutMark();
    }
    return true;
  };

  /** The cut that `payload` came from, if it is still pending and still describes the same cells. */
  const pendingCut = (payload: NonNullable<ReturnType<typeof parseClipboardHtml>>) => {
    const mark = store.getState().clipboard.cutMark;
    if (!payload.cut || !mark || mark.sheetId !== payload.source.sheetId) return null;
    const rows = readRowOrder(target.doc, mark.sheetId);
    const cols = readColOrder(target.doc, mark.sheetId);
    const r = [rows.indexOf(mark.range.anchor.rowId), rows.indexOf(mark.range.focus.rowId)];
    const c = [cols.indexOf(mark.range.anchor.colId), cols.indexOf(mark.range.focus.colId)];
    if (r.includes(-1) || c.includes(-1)) return null;
    const range = normalizeRange(
      { row: Math.min(...r), col: Math.min(...c) },
      { row: Math.max(...r), col: Math.max(...c) },
    );
    const same =
      range.start.row === payload.source.row &&
      range.start.col === payload.source.col &&
      range.end.row - range.start.row + 1 === payload.cells.length &&
      range.end.col - range.start.col + 1 === (payload.cells[0]?.length ?? 0);
    return same ? { sheetId: mark.sheetId, range } : null;
  };

  const selectRange = (range: CellRange) => select({ anchor: range.start, focus: range.end });
  const tooLarge = () =>
    toast(`Paste is too large (the limit is ${MAX_PASTE_CELLS.toLocaleString("en-US")} cells)`);
  const CLIPPED = "Pasted data was cut to fit the sheet";

  const paste = (data: ClipboardDataLike): boolean => {
    const state = store.getState().grid;
    if (state.editing) return false;
    const resolved = resolveSelection(state.selection, model);
    if (!resolved) return false;

    const payload = parseClipboardHtml(data.getData("text/html"));
    let source: PasteSource;
    if (payload) {
      source = { kind: "ours", payload };
    } else {
      const text = data.getData("text/plain");
      if (text === "") return false;
      source = { kind: "text", rows: parseTsv(text) };
    }
    if (target.readOnly) return true;

    const cut = payload ? pendingCut(payload) : null;
    if (payload && cut) {
      if (payload.cells.length * (payload.cells[0]?.length ?? 0) > MAX_PASTE_CELLS) {
        tooLarge();
        return true;
      }
      const moved = moveCells(target, cut, { sheetId, anchor: resolved.anchor });
      clearCutMark();
      if (moved) {
        selectRange(moved.range);
        if (moved.clipped) toast(CLIPPED);
      }
      return true;
    }

    const plan = planPaste({
      source,
      anchor: resolved.anchor,
      selection: resolved.range,
      dims: model.dimensions(),
    });
    if (plan.kind === "tooLarge") {
      tooLarge();
      return true;
    }
    if (pasteEntries(target, sheetId, plan.entries)) {
      selectRange(plan.range);
      if (plan.clipped) toast(CLIPPED);
    }
    return true;
  };

  let fillDrag: { source: CellRange; extent: FillExtent | null } | null = null;
  const setPreview = (range: CellRange | null) => {
    const current = store.getState().grid.fillPreview;
    const same =
      current === range ||
      (current !== null &&
        range !== null &&
        coordsEqual(current.start, range.start) &&
        coordsEqual(current.end, range.end));
    if (!same) store.dispatch(gridActions.fillPreviewChanged(range));
  };
  const fillMove = (clientX: number, clientY: number) => {
    if (!fillDrag) return;
    const pointer = fillPointer(view.hitTest(clientX, clientY));
    if (!pointer) return;
    fillDrag.extent = fillExtent(fillDrag.source, pointer, model.dimensions());
    setPreview(fillDrag.extent?.union ?? null);
  };
  const fillCancel = () => {
    fillDrag = null;
    setPreview(null);
  };
  const fill: FillDrag = {
    begin() {
      const state = store.getState().grid;
      if (target.readOnly || state.editing) return false;
      const resolved = resolveSelection(state.selection, model);
      if (!resolved) return false;
      fillDrag = { source: resolved.range, extent: null };
      view.focus();
      return true;
    },
    move: fillMove,
    end(clientX, clientY) {
      if (!fillDrag) return;
      fillMove(clientX, clientY);
      const { source, extent } = fillDrag;
      fillCancel();
      if (!extent || target.readOnly) return;
      if (fillRange(target, sheetId, model, source, extent)) {
        select({ anchor: extent.union.start, focus: extent.union.end });
      }
    },
    cancel: fillCancel,
  };

  const offs = [
    view.on("pointerDown", (t, e) => {
      view.focus();
      // Clicking elsewhere commits the open edit, like a spreadsheet.
      if (e.button === 0) commitEdit(store.getState().grid.editing?.draft ?? "", null);
      applyPointer(pointerDown(pointer, t, e, pointerContext()));
    }),
    view.on("pointerMove", (t) => {
      applyPointer(pointerMove(pointer, t, pointerContext()));
    }),
    view.on("pointerUp", () => {
      applyPointer(pointerUp());
    }),
    view.on("contextMenu", (t) => {
      // Like a left click elsewhere, opening the menu commits an open edit first.
      commitEdit(store.getState().grid.editing?.draft ?? "", null);
      const selection = contextMenuSelection(t, pointerContext());
      if (selection) select(selection);
    }),
    // Emitted once, on release of a column-resize drag. A refused or unchanged write (viewer,
    // clamped to the stored value) must not leave the grid at the width the user dragged to.
    view.on("columnResized", (col, width) => {
      const colId = model.colIdAt(col);
      if (colId && setColWidth(target.doc, target.readOnly, sheetId, colId, width)) return;
      view.setDimensions(model.dimensions());
      view.refreshCells("all");
    }),
    view.on("doubleClick", (t) => {
      if (isHeaderHit(t) || target.readOnly) return;
      const cell = cellIdAt(t, model);
      if (!cell) return;
      select({ anchor: t, focus: t });
      store.dispatch(
        gridActions.editingStarted({ ...cell, draft: model.getRawInput(t), mode: "edit" }),
      );
    }),
    view.on("keyDown", (key) => {
      const prev = keyboardState();
      if (key.key === "Escape" && !prev.editing) {
        clearCutMark();
        fillCancel();
      }
      apply(prev, reduceKey(prev, key, env()));
    }),
  ];

  return {
    commitEdit,
    cancelEdit() {
      const prev = keyboardState();
      if (prev.editing) apply(prev, cancelEditing(prev));
    },
    copy,
    paste,
    fill,
    startEdit(source) {
      const state = store.getState().grid;
      if (target.readOnly || state.editing) return false;
      const resolved = resolveSelection(state.selection, model);
      const cell = resolved && cellIdAt(resolved.anchor, model);
      if (!resolved || !cell) return false;
      store.dispatch(
        gridActions.editingStarted({
          ...cell,
          draft: model.getRawInput(resolved.anchor),
          mode: "edit",
          source,
        }),
      );
      return true;
    },
    resizeRow(row, height) {
      const rowId = model.rowIdAt(row);
      return (
        rowId !== undefined && setRowHeight(target.doc, target.readOnly, sheetId, rowId, height)
      );
    },
    menuItems() {
      const resolved = resolveSelection(store.getState().grid.selection, model);
      return resolved ? buildMenu(resolved.range, model.dimensions(), target.readOnly) : [];
    },
    runMenuAction,
    updateDraft(text) {
      if (store.getState().grid.editing) store.dispatch(gridActions.draftChanged(text));
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      fillDrag = null;
      target.doc.off("afterTransaction", onTransaction);
      store.dispatch(gridActions.sheetClosed());
    },
  };
}
