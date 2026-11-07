import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { WorkbookSummary } from "@worksheet-clone/shared";
import { getApiErrorMessage } from "../../app/apiErrors";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useLogoutMutation, useMeQuery } from "../auth/authApi";
import { MembersDialog } from "./MembersDialog";
import {
  useCreateWorkbookMutation,
  useDeleteWorkbookMutation,
  useListWorkbooksQuery,
} from "./workbooksApi";

export function WorkbooksPage() {
  const { data: me } = useMeQuery();
  const [logout] = useLogoutMutation();
  const { data: workbooks, isLoading, isError, error } = useListWorkbooksQuery();
  const [pendingDelete, setPendingDelete] = useState<WorkbookSummary | null>(null);
  const [membersOf, setMembersOf] = useState<WorkbookSummary | null>(null);

  const owned = workbooks?.filter((workbook) => workbook.role === "owner") ?? [];
  const shared = workbooks?.filter((workbook) => workbook.role !== "owner") ?? [];

  return (
    <main>
      <header>
        <h1>Worksheet Clone</h1>
        {me && <p>Signed in as {me.user.email}</p>}
        <button type="button" onClick={() => void logout()}>
          Log out
        </button>
      </header>

      <CreateWorkbookForm />

      {isLoading && <p>Loading workbooks…</p>}
      {isError && <p role="alert">{getApiErrorMessage(error)}</p>}

      {workbooks && (
        <>
          <WorkbookSection
            title="My workbooks"
            emptyText="You don't have any workbooks yet."
            workbooks={owned}
            onMembers={setMembersOf}
            onDelete={setPendingDelete}
          />
          <WorkbookSection
            title="Shared with me"
            emptyText="Nothing has been shared with you yet."
            workbooks={shared}
            onMembers={setMembersOf}
          />
        </>
      )}

      {membersOf && <MembersDialog workbook={membersOf} onClose={() => setMembersOf(null)} />}

      {pendingDelete && (
        <DeleteWorkbookDialog workbook={pendingDelete} onClose={() => setPendingDelete(null)} />
      )}
    </main>
  );
}

function CreateWorkbookForm() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createWorkbook, { isLoading }] = useCreateWorkbookMutation();

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await createWorkbook({ name }).unwrap();
      setName("");
    } catch (err) {
      setError(getApiErrorMessage(err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <label>
        New workbook name
        <input
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button type="submit" disabled={isLoading}>
        Create workbook
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

interface WorkbookSectionProps {
  title: string;
  emptyText: string;
  workbooks: WorkbookSummary[];
  onMembers: (workbook: WorkbookSummary) => void;
  onDelete?: (workbook: WorkbookSummary) => void;
}

function WorkbookSection({
  title,
  emptyText,
  workbooks,
  onMembers,
  onDelete,
}: WorkbookSectionProps) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      {workbooks.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <ul>
          {workbooks.map((workbook) => (
            <li key={workbook.id}>
              <Link to={`/workbooks/${workbook.id}`}>{workbook.name}</Link>
              {workbook.role !== "owner" && <span> ({workbook.role})</span>}
              <button
                type="button"
                aria-label={`Members of ${workbook.name}`}
                onClick={() => onMembers(workbook)}
              >
                Members
              </button>
              {onDelete && workbook.role === "owner" && (
                <button
                  type="button"
                  aria-label={`Delete ${workbook.name}`}
                  onClick={() => onDelete(workbook)}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeleteWorkbookDialog({
  workbook,
  onClose,
}: {
  workbook: WorkbookSummary;
  onClose: () => void;
}) {
  const [deleteWorkbook, { isLoading }] = useDeleteWorkbookMutation();
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm(): Promise<void> {
    setError(null);
    try {
      await deleteWorkbook(workbook.id).unwrap();
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err));
    }
  }

  return (
    <ConfirmDialog
      title={`Delete "${workbook.name}"?`}
      message="This permanently deletes the workbook for everyone it's shared with."
      confirmLabel="Delete workbook"
      busy={isLoading}
      error={error}
      onConfirm={() => void handleConfirm()}
      onCancel={onClose}
    />
  );
}
