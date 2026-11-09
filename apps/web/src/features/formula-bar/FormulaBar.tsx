import { useEffect, useReducer, type KeyboardEvent } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { useDocValue } from "../../crdt/useDocValue";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import { MAX_CELL_CHARS } from "../grid/commands/cell-limits";
import type { Direction, GridInteraction } from "../grid/interaction";
import { resolveSelection } from "../grid/interaction";
import type { SheetViewModel } from "../grid/model";
import type { GridView } from "../grid/port";
import { selectionLabel } from "./name-box";
import "./FormulaBar.css";

export interface FormulaBarProps {
  model: SheetViewModel;
  controller: GridInteraction;
  view: GridView;
  readOnly: boolean;
}

/**
 * Name box (the selection in A1 notation) and the formula bar. The bar edits through the
 * same Redux `editing` state as the floating cell editor, so both show one draft; only
 * one of them holds DOM focus, so a keystroke is never inserted twice.
 */
export function FormulaBar({ model, controller, view, readOnly }: FormulaBarProps) {
  const { doc } = useWorkbookDoc();
  const selection = useSelector((s: RootState) => s.grid.selection);
  const editing = useSelector((s: RootState) => s.grid.editing);
  // Structure changes (collaborator inserts rows) move what the selection means.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(
    () =>
      model.subscribe((event) => {
        if (event.type === "dimensions") refresh();
      }),
    [model],
  );

  const resolved = resolveSelection(selection, model);
  const label = resolved ? selectionLabel(resolved.range, model.dimensions()) : "";
  // Not editing: follow the doc, so a collaborator's change to the active cell shows up live.
  const stored = useDocValue(doc, () => (resolved ? model.getRawInput(resolved.anchor) : ""));
  const value = editing ? editing.draft : stored;
  const disabled = readOnly || !resolved;

  const onChange = (text: string) => {
    if (!editing && !controller.startEdit("bar")) return;
    controller.updateDraft(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const move: Direction | null | undefined =
      e.key === "Enter"
        ? e.shiftKey
          ? "up"
          : "down"
        : e.key === "Tab"
          ? e.shiftKey
            ? "left"
            : "right"
          : undefined;
    if (move !== undefined) {
      e.preventDefault();
      if (editing) controller.commitEdit(editing.draft, move);
      view.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      controller.cancelEdit();
      view.focus();
    }
  };

  return (
    <div className="formula-bar" data-testid="formula-bar">
      <output className="formula-bar-name" data-testid="name-box" aria-label="Name box">
        {label}
      </output>
      <input
        className="formula-bar-input"
        aria-label="Formula bar"
        spellCheck={false}
        autoComplete="off"
        maxLength={MAX_CELL_CHARS}
        readOnly={disabled}
        value={value}
        onFocus={() => {
          if (!disabled && !editing) controller.startEdit("bar");
        }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
