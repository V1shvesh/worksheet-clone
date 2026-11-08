import { useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { renameWorkbookSchema, type WorkbookSummary } from "@worksheet-clone/shared";
import { getApiErrorMessage } from "../../app/apiErrors";
import { ConnectionStatus } from "./ConnectionStatus";
import { MembersDialog } from "./MembersDialog";
import { useRenameWorkbookMutation } from "./workbooksApi";

/** Back link, workbook name (owners rename inline), connection status, role and the owner's Share button. */
export function WorkbookHeader({ workbook }: { workbook: WorkbookSummary }) {
  const isOwner = workbook.role === "owner";
  const [sharing, setSharing] = useState(false);

  return (
    <header className="workbook-header">
      <Link to="/" className="workbook-header-back">
        ← All workbooks
      </Link>
      {isOwner ? <EditableName workbook={workbook} /> : <h1>{workbook.name}</h1>}
      <ConnectionStatus />
      <p className="workbook-header-role">Your role: {workbook.role}</p>
      {isOwner && (
        <button type="button" onClick={() => setSharing(true)}>
          Share
        </button>
      )}
      {sharing && <MembersDialog workbook={workbook} onClose={() => setSharing(false)} />}
    </header>
  );
}

function EditableName({ workbook }: { workbook: WorkbookSummary }) {
  const [renameWorkbook] = useRenameWorkbookMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function stop(): void {
    setDraft(null);
    setError(null);
  }

  async function commit(): Promise<void> {
    if (draft === null || saving) return;
    const parsed = renameWorkbookSchema.safeParse({ name: draft });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid name");
      return;
    }
    if (parsed.data.name === workbook.name) {
      stop();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await renameWorkbook({ id: workbook.id, name: parsed.data.name }).unwrap();
      stop();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      stop();
    }
  }

  if (draft === null) {
    return (
      <h1 className="workbook-header-name">
        {workbook.name}{" "}
        <button type="button" aria-label="Rename workbook" onClick={() => setDraft(workbook.name)}>
          Rename
        </button>
      </h1>
    );
  }
  return (
    <div className="workbook-header-name">
      <input
        aria-label="Workbook name"
        value={draft}
        maxLength={100}
        autoFocus
        disabled={saving}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
