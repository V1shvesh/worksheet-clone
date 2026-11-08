import {
  isHeaderHit,
  normalizeRange,
  type CellCoord,
  type GridTarget,
  type PointerInfo,
} from "../port";
import type { IndexSelection } from "./selection";

export interface PointerContext {
  selection: IndexSelection | null;
  rowCount: number;
  colCount: number;
}

/** Which kind of selection the current drag extends. */
export interface PointerState {
  drag: "cell" | "col" | "row" | null;
}

export const initialPointerState: PointerState = { drag: null };

/** `selection` is undefined when the gesture leaves the selection unchanged. */
export interface PointerResult {
  state: PointerState;
  selection?: IndexSelection;
}

const PRIMARY = 0;

function colSelection(
  anchorCol: number,
  focusCol: number,
  ctx: PointerContext,
): IndexSelection | undefined {
  if (ctx.rowCount === 0) return undefined;
  return {
    anchor: { row: 0, col: anchorCol },
    focus: { row: ctx.rowCount - 1, col: focusCol },
  };
}

function rowSelection(
  anchorRow: number,
  focusRow: number,
  ctx: PointerContext,
): IndexSelection | undefined {
  if (ctx.colCount === 0) return undefined;
  return {
    anchor: { row: anchorRow, col: 0 },
    focus: { row: focusRow, col: ctx.colCount - 1 },
  };
}

function inGrid(c: CellCoord, ctx: PointerContext): boolean {
  return c.row >= 0 && c.row < ctx.rowCount && c.col >= 0 && c.col < ctx.colCount;
}

/** The selection a click on `target` produces; `extend` keeps the existing anchor. */
function selectionFor(
  target: GridTarget,
  extend: boolean,
  ctx: PointerContext,
): { selection: IndexSelection | undefined; drag: PointerState["drag"] } {
  const anchor = extend ? ctx.selection?.anchor : undefined;
  if (!isHeaderHit(target)) {
    if (!inGrid(target, ctx)) return { selection: undefined, drag: null };
    return { selection: { anchor: anchor ?? target, focus: target }, drag: "cell" };
  }
  switch (target.kind) {
    case "colHeader":
      return { selection: colSelection(anchor?.col ?? target.col, target.col, ctx), drag: "col" };
    case "rowHeader":
      return { selection: rowSelection(anchor?.row ?? target.row, target.row, ctx), drag: "row" };
    case "corner":
      return {
        selection:
          ctx.rowCount === 0 || ctx.colCount === 0
            ? undefined
            : {
                anchor: { row: 0, col: 0 },
                focus: { row: ctx.rowCount - 1, col: ctx.colCount - 1 },
              },
        drag: null,
      };
  }
}

export function pointerDown(
  state: PointerState,
  target: GridTarget,
  e: PointerInfo,
  ctx: PointerContext,
): PointerResult {
  // Secondary buttons are handled by `contextMenuSelection`.
  if (e.button !== PRIMARY) return { state };
  const { selection, drag } = selectionFor(target, e.shiftKey, ctx);
  return { state: { drag: selection ? drag : null }, selection };
}

export function pointerMove(
  state: PointerState,
  target: GridTarget,
  ctx: PointerContext,
): PointerResult {
  const { drag } = state;
  const current = ctx.selection;
  if (!drag || !current) return { state };
  if (drag === "cell") {
    if (isHeaderHit(target) || !inGrid(target, ctx)) return { state };
    return { state, selection: { anchor: current.anchor, focus: target } };
  }
  // Dragging along a header strip: cells in the same column/row count as the header.
  if (drag === "col") {
    const col = isHeaderHit(target)
      ? target.kind === "colHeader"
        ? target.col
        : undefined
      : target.col;
    const selection = col === undefined ? undefined : colSelection(current.anchor.col, col, ctx);
    return { state, selection };
  }
  const row = isHeaderHit(target)
    ? target.kind === "rowHeader"
      ? target.row
      : undefined
    : target.row;
  const selection = row === undefined ? undefined : rowSelection(current.anchor.row, row, ctx);
  return { state, selection };
}

export function pointerUp(): PointerResult {
  return { state: initialPointerState };
}

/**
 * Right-click keeps the selection if it already covers the target, otherwise
 * selects the target (cell, whole column or row, or everything).
 */
export function contextMenuSelection(
  target: GridTarget,
  ctx: PointerContext,
): IndexSelection | undefined {
  const { selection } = selectionFor(target, false, ctx);
  if (!selection) return undefined;
  if (ctx.selection) {
    const have = normalizeRange(ctx.selection.anchor, ctx.selection.focus);
    const want = normalizeRange(selection.anchor, selection.focus);
    const covers =
      want.start.row >= have.start.row &&
      want.end.row <= have.end.row &&
      want.start.col >= have.start.col &&
      want.end.col <= have.end.col;
    if (covers) return undefined;
  }
  return selection;
}
