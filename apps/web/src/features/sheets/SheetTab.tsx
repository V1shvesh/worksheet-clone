import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useSheetName } from "../../crdt/useDocValue";
import type { RenameResult } from "../../crdt/mutations";

export type DropMarker = "before" | "after" | null;

interface SheetTabProps {
  sheetId: string;
  selected: boolean;
  canEdit: boolean;
  renaming: boolean;
  dropMarker: DropMarker;
  dragging: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onOpen: () => void;
  onStartRename: () => void;
  onEndRename: () => void;
  rename: (name: string) => RenameResult;
  onMenu: (x: number, y: number) => void;
  onArrow: (direction: -1 | 1) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerEnd: (event: PointerEvent<HTMLElement>, cancelled: boolean) => void;
  /** Returns true when the click was the tail of a drag and must be ignored. */
  consumeDragClick: () => boolean;
}

/** One tab: switch on click, rename inline on double-click, context menu on right-click. */
export function SheetTab(props: SheetTabProps) {
  const { sheetId, selected, canEdit, renaming } = props;
  const name = useSheetName(sheetId) ?? "";

  const classes = ["sheet-tab"];
  if (selected) classes.push("sheet-tab--selected");
  if (props.dragging) classes.push("sheet-tab--dragging");
  if (props.dropMarker) classes.push(`sheet-tab--drop-${props.dropMarker}`);

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onOpen();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      props.onArrow(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "F2" && canEdit) {
      event.preventDefault();
      props.onStartRename();
    }
  }

  return (
    <div
      ref={props.registerEl}
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={classes.join(" ")}
      data-testid="sheet-tab"
      data-sheet-id={sheetId}
      title={name}
      onClick={() => {
        if (!props.consumeDragClick() && !renaming) props.onOpen();
      }}
      onDoubleClick={() => canEdit && props.onStartRename()}
      onContextMenu={(event) => {
        if (!canEdit) return;
        event.preventDefault();
        props.onOpen();
        props.onMenu(event.clientX, event.clientY);
      }}
      onKeyDown={onKeyDown}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={(event) => props.onPointerEnd(event, false)}
      onPointerCancel={(event) => props.onPointerEnd(event, true)}
    >
      {renaming ? (
        <RenameInput name={name} rename={props.rename} onEnd={props.onEndRename} />
      ) : (
        <span className="sheet-tab-name">{name}</span>
      )}
    </div>
  );
}

function RenameInput({
  name,
  rename,
  onEnd,
}: {
  name: string;
  rename: (name: string) => RenameResult;
  onEnd: () => void;
}) {
  // The draft is local, so a collaborator's rename changes the tab label
  // behind it without touching what is being typed.
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function finish(): void {
    finished.current = true;
    onEnd();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation(); // typing must not reach the tab's own shortcuts
    if (event.key === "Enter") {
      event.preventDefault();
      const result = rename(draft);
      if (result.ok) finish();
      else setError(result.error);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  }

  return (
    <>
      <input
        ref={input}
        className="sheet-tab-input"
        aria-label="Sheet name"
        aria-invalid={error ? true : undefined}
        value={draft}
        maxLength={100}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={() => {
          if (finished.current) return;
          // Blur commits a valid name and silently drops an invalid one.
          rename(draft);
          finish();
        }}
      />
      {error && (
        <span role="alert" className="sheet-tab-error">
          {error}
        </span>
      )}
    </>
  );
}
