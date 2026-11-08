import type { CellCoord, CellRange, KeyInfo } from "../port";
import { normalizeRange } from "../port";
import type { IndexSelection } from "./selection";

export type Direction = "up" | "down" | "left" | "right";

/** Editing state in visual indices (the Redux copy stores ids). */
export interface EditingIndexState {
  cell: CellCoord;
  draft: string;
  mode: "typing" | "edit";
}

export interface KeyboardState {
  selection: IndexSelection | null;
  editing: EditingIndexState | null;
}

export type GridCommand =
  { type: "setCellInput"; cell: CellCoord; raw: string } | { type: "clearRange"; range: CellRange };

export interface KeyboardEnv {
  rowCount: number;
  colCount: number;
  readOnly: boolean;
  getRawInput(cell: CellCoord): string;
}

export interface KeyboardResult {
  state: KeyboardState;
  commands: GridCommand[];
}

const STEP: Record<Direction, CellCoord> = {
  up: { row: -1, col: 0 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
  right: { row: 0, col: 1 },
};

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function clampMove(from: CellCoord, dir: Direction, env: KeyboardEnv): CellCoord {
  const step = STEP[dir];
  return {
    row: Math.min(Math.max(0, from.row + step.row), env.rowCount - 1),
    col: Math.min(Math.max(0, from.col + step.col), env.colCount - 1),
  };
}

const collapsed = (c: CellCoord): IndexSelection => ({ anchor: c, focus: c });

// Cmd/Ctrl combos are shortcuts (clipboard, undo… later). Alt alone or Ctrl+Alt
// (Windows AltGr) can TYPE characters such as "€" or "@" on many layouts, so
// those only count as shortcuts when they don't produce a character.
function isShortcut(key: KeyInfo): boolean {
  if (key.metaKey) return true;
  if (key.ctrlKey && !key.altKey) return true;
  return key.altKey && !isPrintable(key.key);
}

/** A single printable character; named keys ("Shift", "Enter", ...) are longer. */
function isPrintable(key: string): boolean {
  return [...key].length === 1;
}

/**
 * Ends editing, writing the draft, and optionally moves the (collapsed) selection.
 * Used by the Enter/Tab keys and by the overlay editor's own commit.
 */
export function commitEditing(
  state: KeyboardState,
  draft: string,
  move: Direction | null,
  env: KeyboardEnv,
): KeyboardResult {
  const editing = state.editing;
  if (!editing) return { state, commands: [] };
  const commands: GridCommand[] = env.readOnly
    ? []
    : [{ type: "setCellInput", cell: editing.cell, raw: draft }];
  const selection = move
    ? collapsed(clampMove(editing.cell, move, env))
    : (state.selection ?? collapsed(editing.cell));
  return { state: { selection, editing: null }, commands };
}

export function cancelEditing(state: KeyboardState): KeyboardResult {
  return { state: { ...state, editing: null }, commands: [] };
}

function reduceEditingKey(state: KeyboardState, key: KeyInfo, env: KeyboardEnv): KeyboardResult {
  const editing = state.editing!;
  if (key.ctrlKey || key.metaKey || key.altKey) return { state, commands: [] };
  switch (key.key) {
    case "Enter":
      return commitEditing(state, editing.draft, key.shiftKey ? "up" : "down", env);
    case "Tab":
      return commitEditing(state, editing.draft, key.shiftKey ? "left" : "right", env);
    case "Escape":
      return cancelEditing(state);
    default:
      // Everything else belongs to the editor input.
      return { state, commands: [] };
  }
}

/**
 * Pure keyboard map. Ctrl/Cmd/Alt combos are ignored (clipboard and undo arrive
 * later). Returns the next selection/editing state plus commands for the caller
 * to run; it never writes anything itself.
 */
export function reduceKey(state: KeyboardState, key: KeyInfo, env: KeyboardEnv): KeyboardResult {
  if (env.rowCount === 0 || env.colCount === 0) return { state, commands: [] };
  if (state.editing) return reduceEditingKey(state, key, env);
  if (isShortcut(key)) return { state, commands: [] };

  const sel = state.selection;
  const arrow = ARROWS[key.key];
  const move = (dir: Direction): KeyboardResult => {
    if (!sel)
      return { state: { ...state, selection: collapsed({ row: 0, col: 0 }) }, commands: [] };
    // As in Excel/Sheets: the anchor is the active cell. Shift+arrows move the range's far
    // corner (focus); any other move starts from the active cell and collapses the range.
    const extend = key.shiftKey && arrow !== undefined;
    const next = clampMove(extend ? sel.focus : sel.anchor, dir, env);
    return {
      state: {
        ...state,
        selection: extend ? { anchor: sel.anchor, focus: next } : collapsed(next),
      },
      commands: [],
    };
  };

  if (arrow) return move(arrow);
  if (key.key === "Tab") return move(key.shiftKey ? "left" : "right");

  if (!sel) return { state, commands: [] };
  const active = sel.anchor;
  const startEditing = (draft: string, mode: "typing" | "edit"): KeyboardResult =>
    env.readOnly
      ? { state, commands: [] }
      : {
          state: { selection: collapsed(active), editing: { cell: active, draft, mode } },
          commands: [],
        };

  switch (key.key) {
    case "Enter":
      return key.shiftKey ? move("up") : startEditing(env.getRawInput(active), "edit");
    case "F2":
      return startEditing(env.getRawInput(active), "edit");
    case "Delete":
    case "Backspace":
      if (env.readOnly) return { state, commands: [] };
      return {
        state,
        commands: [{ type: "clearRange", range: normalizeRange(sel.anchor, sel.focus) }],
      };
    case "Escape":
      return { state, commands: [] };
    default:
      return isPrintable(key.key) ? startEditing(key.key, "typing") : { state, commands: [] };
  }
}
