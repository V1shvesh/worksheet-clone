import { useState, type KeyboardEvent } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { useWorkbookMutations } from "../../crdt/mutations";
import { useSheetName, useSheetOrder } from "../../crdt/useDocValue";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";

// Scaffold for M3: proves the live document end to end (connection status,
// sheet list, a synced sheet name). M4b/M5 replace it with the grid and tabs.
export function LiveWorkbook() {
  const sheetOrder = useSheetOrder();
  const [firstSheetId] = sheetOrder;

  return (
    <section aria-label="Live document">
      <ConnectionStatus />
      <ul aria-label="Sheets">
        {sheetOrder.map((sheetId) => (
          <SheetListItem key={sheetId} sheetId={sheetId} />
        ))}
      </ul>
      {firstSheetId && <SheetNameField sheetId={firstSheetId} />}
    </section>
  );
}

function ConnectionStatus() {
  const { status, synced, access } = useSelector((state: RootState) => state.collab);

  if (access === "denied") {
    return <p role="alert">You don't have access to this workbook anymore.</p>;
  }
  const label =
    status === "connected" && synced
      ? "Live"
      : status === "disconnected"
        ? "Offline — reconnecting…"
        : "Connecting…";
  return (
    <p role="status" aria-label="Connection">
      {label}
      {access === "read-only" && " · View only"}
    </p>
  );
}

function SheetListItem({ sheetId }: { sheetId: string }) {
  const name = useSheetName(sheetId);
  return <li>{name}</li>;
}

function SheetNameField({ sheetId }: { sheetId: string }) {
  const { readOnly } = useWorkbookDoc();
  const { renameSheet } = useWorkbookMutations();
  const name = useSheetName(sheetId) ?? "";
  // While editing, the draft wins; otherwise the field follows the doc, so
  // remote renames show up live without clobbering what the user is typing.
  const [draft, setDraft] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  function finish(): void {
    setDraft(null);
    setError(null);
  }

  function commit(keepOpenOnError: boolean): void {
    if (draft === null) return;
    const result = renameSheet(sheetId, draft);
    if (!result.ok && keepOpenOnError) {
      setError(result.error);
      return;
    }
    finish();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      commit(true);
    } else if (event.key === "Escape") {
      finish();
    }
  }

  return (
    <label>
      First sheet name
      <input
        value={draft ?? name}
        readOnly={readOnly}
        maxLength={100}
        onFocus={() => !readOnly && setDraft(name)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(false)}
        onKeyDown={handleKeyDown}
      />
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
