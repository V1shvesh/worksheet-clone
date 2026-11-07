import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, WorkbookSummary } from "@worksheet-clone/shared";

const addMember = vi.fn();
const changeRole = vi.fn();
const removeMember = vi.fn();
const members: Member[] = [
  { userId: "u1", email: "owner@example.com", role: "owner" },
  { userId: "u2", email: "ed@example.com", role: "editor" },
  { userId: "u3", email: "vi@example.com", role: "viewer" },
];

vi.mock("./membersApi", () => ({
  useListMembersQuery: () => ({ data: members, isLoading: false, isError: false }),
  useAddMemberMutation: () => [addMember, { isLoading: false }],
  useChangeMemberRoleMutation: () => [changeRole],
  useRemoveMemberMutation: () => [removeMember],
}));

const { MembersDialog } = await import("./MembersDialog");

const resolved = () => ({ unwrap: () => Promise.resolve() });
const rejected = (code: string, message: string) => ({
  unwrap: () => Promise.reject({ status: 404, data: { error: { code, message } } }),
});

function renderDialog(role: WorkbookSummary["role"], onClose = vi.fn()) {
  const now = new Date().toISOString();
  render(
    <MembersDialog
      workbook={{ id: "w1", name: "Budget", role, createdAt: now, updatedAt: now }}
      onClose={onClose}
    />,
  );
  return onClose;
}

beforeEach(() => {
  for (const mock of [addMember, changeRole, removeMember]) {
    mock.mockReset().mockReturnValue(resolved());
  }
});
afterEach(cleanup);

describe("MembersDialog", () => {
  it("lets the owner change roles and remove anyone but the owner", () => {
    renderDialog("owner");

    const list = screen.getByRole("list", { name: "Members" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByLabelText("Role for owner@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove owner@example.com" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Role for vi@example.com"), {
      target: { value: "editor" },
    });
    expect(changeRole).toHaveBeenCalledWith({ workbookId: "w1", userId: "u3", role: "editor" });

    fireEvent.click(screen.getByRole("button", { name: "Remove ed@example.com" }));
    expect(removeMember).toHaveBeenCalledWith({ workbookId: "w1", userId: "u2" });
  });

  it("adds a person by email, defaulting to viewer", async () => {
    renderDialog("owner");

    const form = screen.getByRole("form", { name: "Add a person" });
    const email = within(form).getByLabelText("Email");
    fireEvent.change(email, { target: { value: "new@example.com" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    expect(addMember).toHaveBeenCalledWith({
      workbookId: "w1",
      email: "new@example.com",
      role: "viewer",
    });
    await waitFor(() => expect(email).toHaveValue(""));
  });

  it("shows the server's error when adding fails", async () => {
    addMember.mockReturnValue(rejected("USER_NOT_FOUND", "No account exists with that email"));
    renderDialog("owner");

    const form = screen.getByRole("form", { name: "Add a person" });
    fireEvent.change(within(form).getByLabelText("Email"), {
      target: { value: "ghost@example.com" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No account exists with that email");
  });

  it.each(["editor", "viewer"] as const)("is read-only for an %s", (role) => {
    renderDialog(role);

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add a person" })).not.toBeInTheDocument();
  });

  it("closes via the Close button and Escape", () => {
    const onClose = renderDialog("viewer");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
