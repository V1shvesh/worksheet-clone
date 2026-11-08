import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../../app/store";
import type { GridInteraction, IdMapper } from "../interaction";
import { resolveSelection, type Direction, type IdSelection } from "../interaction";
import type { SheetViewModel } from "../model";
import { rangeContains, type GridView, type Rect } from "../port";
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
  const fillPreview = useSelector((s: RootState) => s.grid.fillPreview);
  const cutMark = useSelector((s: RootState) => s.clipboard.cutMark);
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

  // The fill handle sits on the selection's bottom-right corner, only while that cell is on screen.
  const handleCell =
    resolved && !readOnly && !editing && rangeContains(view.getVisibleRange(), resolved.range.end)
      ? view.getCellRect(resolved.range.end)
      : null;
  const previewRect = fillPreview && visibleRangeRect(view, fillPreview);

  // The cut mark is only drawn on the sheet it was cut from.
  const markSelection: IdSelection | null =
    cutMark && cutMark.sheetId === model.sheetId ? cutMark.range : null;
  const markResolved = resolveSelection(markSelection, mapper);
  const cutRect = markResolved && visibleRangeRect(view, markResolved.range);

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
      {previewRect && (
        <div className="grid-fill-preview" data-testid="fill-preview" style={px(previewRect)} />
      )}
      {handleCell && <FillHandle rect={handleCell} controller={controller} />}
      {cutRect && <div className="grid-cut-rect" data-testid="cut-rect" style={px(cutRect)} />}
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

const HANDLE_SIZE = 8;

function FillHandle({ rect, controller }: { rect: Rect; controller: GridInteraction }) {
  const dragging = useRef(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // No text selection or focus change: the grid keeps focus (and so Escape).
    e.preventDefault();
    e.stopPropagation();
    if (!controller.fill.begin()) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) controller.fill.move(e.clientX, e.clientY);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    controller.fill.end(e.clientX, e.clientY);
  };
  const onPointerCancel = () => {
    if (!dragging.current) return;
    dragging.current = false;
    controller.fill.cancel();
  };
  return (
    <div
      className="grid-fill-handle"
      data-testid="fill-handle"
      style={{
        left: rect.x + rect.width - HANDLE_SIZE / 2,
        top: rect.y + rect.height - HANDLE_SIZE / 2,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
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
