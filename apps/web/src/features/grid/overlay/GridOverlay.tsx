import { useEffect, useLayoutEffect, useReducer, useRef, type KeyboardEvent } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../../app/store";
import type { GridInteraction, IdMapper } from "../interaction";
import { resolveSelection, type Direction } from "../interaction";
import type { SheetViewModel } from "../model";
import type { GridView, Rect } from "../port";
import { visibleRangeRect } from "./geometry";

export interface GridOverlayProps {
  view: GridView;
  model: SheetViewModel;
  controller: GridInteraction;
  readOnly: boolean;
}

const px = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });

/**
 * Selection rectangle, active-cell outline and floating editor. Positions come only from
 * `view.getCellRect` (relative to the grid's mount element, which this layer exactly covers).
 * The layer ignores pointer events so the grid keeps receiving them.
 */
export function GridOverlay({ view, model, controller, readOnly }: GridOverlayProps) {
  const selection = useSelector((s: RootState) => s.grid.selection);
  const editing = useSelector((s: RootState) => s.grid.editing);
  // Geometry changes without any Redux change (scroll, resize, structure edits).
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const offScroll = view.on("scroll", refresh);
    const offModel = model.subscribe((event) => {
      if (event.type === "dimensions") refresh();
    });
    window.addEventListener("resize", refresh);
    return () => {
      offScroll();
      offModel();
      window.removeEventListener("resize", refresh);
    };
  }, [view, model]);

  // Access can be revoked mid-edit; a viewer must not be left holding an editor.
  useEffect(() => {
    if (readOnly && editing) controller.cancelEdit();
  }, [readOnly, editing, controller]);

  const mapper: IdMapper = model;
  const resolved = resolveSelection(selection, mapper);
  const selectionRect = resolved && visibleRangeRect(view, resolved.range);
  // The anchor is the active cell (Excel/Sheets); Shift+arrows move only the far corner.
  const activeRect = resolved && view.getCellRect(resolved.anchor);

  const editRow = editing ? model.rowIndexOf(editing.rowId) : undefined;
  const editCol = editing ? model.colIndexOf(editing.colId) : undefined;
  const editRect =
    !readOnly && editing && editRow !== undefined && editCol !== undefined
      ? view.getCellRect({ row: editRow, col: editCol })
      : null;

  return (
    <div className="grid-overlay">
      {selectionRect && (
        <div
          className="grid-selection-rect"
          data-testid="selection-rect"
          style={px(selectionRect)}
        />
      )}
      {activeRect && (
        <div className="grid-active-cell" data-testid="active-cell" style={px(activeRect)} />
      )}
      {editing && !readOnly && (
        <CellEditor
          key={`${editing.rowId}:${editing.colId}`}
          draft={editing.draft}
          // Off-screen edit cells keep their (focused) editor mounted but hidden.
          rect={editRect}
          controller={controller}
          view={view}
          takeFocus={editing.source !== "bar"}
        />
      )}
    </div>
  );
}

interface CellEditorProps {
  draft: string;
  rect: Rect | null;
  controller: GridInteraction;
  view: GridView;
  /** False when the formula bar started the edit: it keeps focus and mirrors the same draft. */
  takeFocus: boolean;
}

function moveFor(e: KeyboardEvent): Direction | null | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  if (e.key === "Enter") return e.shiftKey ? "up" : "down";
  if (e.key === "Tab") return e.shiftKey ? "left" : "right";
  return undefined;
}

function CellEditor({ draft, rect, controller, view, takeFocus }: CellEditorProps) {
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !takeFocus) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Focus is decided once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // This input is outside the adapter's container, so its key events never reach the
  // controller's keyDown path: Enter/Tab/Escape are handled here and only here.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const move = moveFor(e);
    const cancel = e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (move === undefined && !cancel) return;
    e.preventDefault();
    e.stopPropagation();
    if (cancel) controller.cancelEdit();
    else controller.commitEdit(e.currentTarget.value, move ?? null);
    view.focus();
  };

  const width = rect ? Math.max(rect.width, draft.length * 8 + 16) : undefined;
  return (
    <input
      ref={input}
      className="grid-cell-editor"
      data-testid="cell-editor"
      aria-label="Cell editor"
      spellCheck={false}
      autoComplete="off"
      value={draft}
      onChange={(e) => controller.updateDraft(e.target.value)}
      onKeyDown={onKeyDown}
      style={rect ? { ...px(rect), width } : { visibility: "hidden" }}
    />
  );
}
