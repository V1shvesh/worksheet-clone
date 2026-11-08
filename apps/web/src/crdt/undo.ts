import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import { getSheetOrderArray, getSheetsMap } from "@worksheet-clone/shared";
import type { IdSelection } from "../features/grid/interaction/selection";
import { LOCAL_ORIGIN } from "./origin";
import { useWorkbookDoc } from "./WorkbookDoc";

/**
 * What the user was looking at when an action happened: the open sheet and the
 * selection (by ids, so it survives collaborators' structure edits).
 */
export interface UndoContext {
  sheetId: string | null;
  selection: IdSelection | null;
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

export interface WorkbookUndo {
  /** Undoes your most recent action; returns where to restore the view, or null if nothing happened. */
  undo(): { context: UndoContext | null } | null;
  redo(): { context: UndoContext | null } | null;
  /** Stable snapshot (same object until a stack changes), for useSyncExternalStore. */
  getState(): UndoState;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

export interface WorkbookUndoDeps {
  /** Read on every undo/redo, so access changes apply live. */
  isReadOnly(): boolean;
  /** Called when an action lands on the undo stack. */
  getContext(): UndoContext;
}

const CONTEXT_KEY = "context";

/**
 * One UndoManager per Y.Doc. Each LOCAL_ORIGIN transaction is exactly one
 * undo step (`captureTimeout: 0`), and only your own transactions are
 * tracked, so undo never reverts a collaborator's edit. Scope is the sheets
 * map and the sheet order: cell contents, formats, and sheet add / rename /
 * hide / delete / move.
 *
 * View restore: a step remembers the context of the ORIGINAL action. Undo and
 * redo both restore that context (Sheets does the same: both land on the
 * range the action changed), so redo stack items inherit the context of the
 * step that was popped instead of recording where you were when you pressed undo.
 */
export function createWorkbookUndo(doc: Y.Doc, deps: WorkbookUndoDeps): WorkbookUndo {
  const manager = new Y.UndoManager([getSheetsMap(doc), getSheetOrderArray(doc)], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 0,
  });

  // Set only while undo()/redo() runs: the stack item added by that call is the
  // mirror of the popped one and carries its context; everything else is a new action.
  let inherit: { context: UndoContext | null } | null = null;

  const onAdded = ({ stackItem }: { stackItem: Y.UndoManager["undoStack"][number] }) => {
    stackItem.meta.set(CONTEXT_KEY, inherit ? inherit.context : deps.getContext());
  };
  manager.on("stack-item-added", onAdded);

  let state: UndoState = { canUndo: false, canRedo: false };
  const listeners = new Set<() => void>();
  const refresh = () => {
    const next = { canUndo: manager.canUndo(), canRedo: manager.canRedo() };
    if (next.canUndo === state.canUndo && next.canRedo === state.canRedo) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared"] as const) {
    manager.on(event, refresh);
  }

  const run = (kind: "undo" | "redo", stack: Y.UndoManager["undoStack"]) => {
    if (deps.isReadOnly() || stack.length === 0) return null;
    const top = stack[stack.length - 1]!;
    inherit = { context: (top.meta.get(CONTEXT_KEY) as UndoContext | undefined) ?? null };
    try {
      const item = kind === "undo" ? manager.undo() : manager.redo();
      return item ? { context: inherit.context } : null;
    } finally {
      inherit = null;
    }
  };

  return {
    undo: () => run("undo", manager.undoStack),
    redo: () => run("redo", manager.redoStack),
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
      manager.destroy();
    },
  };
}

const NONE: UndoState = { canUndo: false, canRedo: false };

/** Undo/redo for the open workbook; both are no-ops (and report false) while read-only. */
export function useWorkbookUndo(): UndoState & {
  undo: WorkbookUndo["undo"];
  redo: WorkbookUndo["redo"];
  readOnly: boolean;
} {
  const { undo, readOnly } = useWorkbookDoc();
  const state = useSyncExternalStore(
    undo ? undo.subscribe : noopSubscribe,
    undo ? undo.getState : () => NONE,
  );
  return {
    canUndo: !readOnly && state.canUndo,
    canRedo: !readOnly && state.canRedo,
    undo: () => undo?.undo() ?? null,
    redo: () => undo?.redo() ?? null,
    readOnly,
  };
}

function noopSubscribe(): () => void {
  return () => {};
}
