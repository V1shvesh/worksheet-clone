import { useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { useDocValue } from "../../crdt/useDocValue";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import {
  activeCellFormat,
  formatSelection,
  toggleFormat,
  type FormatFlag,
} from "../grid/commands/format-selection";
import { FILL_COLORS } from "./fill-colors";
import { useUndoRedo } from "./useUndoRedo";
import "./Toolbar.css";

const FLAGS: { flag: FormatFlag; label: string; glyph: string; title: string }[] = [
  { flag: "b", label: "Bold", glyph: "B", title: "Bold (Ctrl+B)" },
  { flag: "i", label: "Italic", glyph: "I", title: "Italic (Ctrl+I)" },
  { flag: "u", label: "Underline", glyph: "U", title: "Underline (Ctrl+U)" },
];

/** Undo/redo and formatting for the open workbook; sits above the grid. */
export function Toolbar() {
  const { doc, readOnly } = useWorkbookDoc();
  const { canUndo, canRedo, undo, redo } = useUndoRedo();
  const sheetId = useSelector((s: RootState) => s.grid.sheetId);
  const selection = useSelector((s: RootState) => s.grid.selection);
  // The active cell's format, live: remote changes and selection moves both update it.
  const format = useDocValue(
    doc,
    (d) => (sheetId ? activeCellFormat(d, sheetId, selection) : undefined),
    (a, b) => a?.b === b?.b && a?.i === b?.i && a?.u === b?.u && a?.bg === b?.bg,
  );
  const canFormat = !readOnly && sheetId !== null && selection !== null;

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Toolbar"
      data-testid="toolbar"
      // Clicking a button must not pull keyboard focus out of the grid.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={undo}
      >
        ↶
      </button>
      <button
        type="button"
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={redo}
      >
        ↷
      </button>
      <span className="toolbar-separator" role="separator" />
      {FLAGS.map(({ flag, label, glyph, title }) => (
        <button
          key={flag}
          type="button"
          aria-label={label}
          aria-pressed={format?.[flag] === true}
          title={title}
          disabled={!canFormat}
          className={`toolbar-format toolbar-format-${flag}`}
          onClick={() => {
            if (sheetId && selection) toggleFormat({ doc, readOnly }, sheetId, selection, flag);
          }}
        >
          {glyph}
        </button>
      ))}
      <FillColor
        disabled={!canFormat}
        current={format?.bg}
        onPick={(bg) => {
          if (sheetId && selection) formatSelection({ doc, readOnly }, sheetId, selection, { bg });
        }}
      />
    </div>
  );
}

function FillColor({
  disabled,
  current,
  onPick,
}: {
  disabled: boolean;
  current: string | undefined;
  onPick: (bg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A selection change or lost edit right closes a popover that can no longer apply.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <span className="toolbar-fill" ref={root}>
      <button
        type="button"
        aria-label="Fill color"
        aria-haspopup="true"
        aria-expanded={open}
        title="Fill color"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className="toolbar-fill-glyph"
          style={{ borderBottomColor: current ?? "transparent" }}
        >
          A
        </span>
      </button>
      {open && (
        <div className="toolbar-fill-popover" role="group" aria-label="Fill colors">
          {FILL_COLORS.map(({ name, value }) => (
            <button
              key={value}
              type="button"
              className="toolbar-swatch"
              aria-label={name}
              aria-pressed={current === value}
              title={name}
              style={{ background: value }}
              onClick={() => {
                onPick(value);
                setOpen(false);
              }}
            />
          ))}
          <button
            type="button"
            className="toolbar-fill-none"
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            None
          </button>
        </div>
      )}
    </span>
  );
}
