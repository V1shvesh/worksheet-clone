import { useState, type FormEvent } from "react";
import type { AssignableRole, Member, WorkbookSummary } from "@worksheet-clone/shared";
import { getApiErrorMessage } from "../../app/apiErrors";
import { Dialog } from "../../components/Dialog";
import {
  useAddMemberMutation,
  useChangeMemberRoleMutation,
  useListMembersQuery,
  useRemoveMemberMutation,
} from "./membersApi";

interface MembersDialogProps {
  workbook: WorkbookSummary;
  onClose: () => void;
}

export function MembersDialog({ workbook, onClose }: MembersDialogProps) {
  const canManage = workbook.role === "owner";
  const { data: members, isLoading, isError, error } = useListMembersQuery(workbook.id);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(getApiErrorMessage(err));
    }
  }

  return (
    <Dialog title={`People with access to "${workbook.name}"`} onClose={onClose}>
      {isLoading && <p>Loading…</p>}
      {isError && <p role="alert">{getApiErrorMessage(error)}</p>}
      {actionError && <p role="alert">{actionError}</p>}

      {members && (
        <ul aria-label="Members">
          {members.map((member) => (
            <MemberRow
              key={member.userId}
              workbookId={workbook.id}
              member={member}
              canManage={canManage}
              run={run}
            />
          ))}
        </ul>
      )}

      {canManage && <AddMemberForm workbookId={workbook.id} run={run} />}

      <button type="button" onClick={onClose}>
        Close
      </button>
    </Dialog>
  );
}

interface MemberRowProps {
  workbookId: string;
  member: Member;
  canManage: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

function MemberRow({ workbookId, member, canManage, run }: MemberRowProps) {
  const [changeRole] = useChangeMemberRoleMutation();
  const [removeMember] = useRemoveMemberMutation();
  const editable = canManage && member.role !== "owner";

  return (
    <li>
      <span>{member.email}</span>{" "}
      {editable ? (
        <>
          <select
            aria-label={`Role for ${member.email}`}
            value={member.role}
            onChange={(event) =>
              void run(() =>
                changeRole({
                  workbookId,
                  userId: member.userId,
                  role: event.target.value as AssignableRole,
                }).unwrap(),
              )
            }
          >
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
          <button
            type="button"
            aria-label={`Remove ${member.email}`}
            onClick={() =>
              void run(() => removeMember({ workbookId, userId: member.userId }).unwrap())
            }
          >
            Remove
          </button>
        </>
      ) : (
        <span>{member.role}</span>
      )}
    </li>
  );
}

function AddMemberForm({
  workbookId,
  run,
}: {
  workbookId: string;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("viewer");
  const [addMember, { isLoading }] = useAddMemberMutation();

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void run(async () => {
      await addMember({ workbookId, email, role }).unwrap();
      setEmail("");
    });
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Add a person">
      <label>
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        Role
        <select value={role} onChange={(event) => setRole(event.target.value as AssignableRole)}>
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
        </select>
      </label>
      <button type="submit" disabled={isLoading}>
        Add
      </button>
    </form>
  );
}
