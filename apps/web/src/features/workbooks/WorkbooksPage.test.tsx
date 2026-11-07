import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbookSummary } from "@worksheet-clone/shared";

const createWorkbook = vi.fn();
const deleteWorkbook = vi.fn();
let workbooks: WorkbookSummary[] = [];

// Mock the hook modules, not fetch: RTK Query's fetchBaseQuery trips over
// jsdom's AbortController (see docs/failure-log.md).
vi.mock("../auth/authApi", () => ({
  useMeQuery: () => ({ data: { user: { id: "u1", email: "me@example.com" } } }),
  useLogoutMutation: () => [vi.fn()],
}));
vi.mock("./workbooksApi", () => ({
  useListWorkbooksQuery: () => ({ data: workbooks, isLoading: false, isError: false }),
  useCreateWorkbookMutation: () => [createWorkbook, { isLoading: false }],
  useDeleteWorkbookMutation: () => [deleteWorkbook, { isLoading: false }],
}));

const { WorkbooksPage } = await import("./WorkbooksPage");

function workbook(id: string, name: string, role: WorkbookSummary["role"]): WorkbookSummary {
  const now = new Date().toISOString();
  return { id, name, role, createdAt: now, updatedAt: now };
}

function renderPage() {
  render(
    <MemoryRouter>
      <WorkbooksPage />
    </MemoryRouter>,
  );
}

const resolved = (value?: unknown) => ({ unwrap: () => Promise.resolve(value) });

beforeEach(() => {
  workbooks = [
    workbook("w1", "Budget", "owner"),
    workbook("w2", "Team plan", "editor"),
    workbook("w3", "Roadmap", "viewer"),
  ];
  createWorkbook.mockReset().mockReturnValue(resolved());
  deleteWorkbook.mockReset().mockReturnValue(resolved());
});
afterEach(cleanup);

describe("WorkbooksPage", () => {
  it("splits owned and shared workbooks, labelling shared roles", () => {
    renderPage();

    const mine = screen.getByRole("region", { name: "My workbooks" });
    const shared = screen.getByRole("region", { name: "Shared with me" });
    expect(within(mine).getByRole("link", { name: "Budget" })).toHaveAttribute(
      "href",
      "/workbooks/w1",
    );
    expect(within(shared).getByText("(editor)")).toBeInTheDocument();
    expect(within(shared).getByText("(viewer)")).toBeInTheDocument();
  });

  it("offers delete only on owned workbooks", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Delete Budget" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Team plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Roadmap" })).not.toBeInTheDocument();
  });

  it("deletes only after confirming", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Budget" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete "Budget"?' });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteWorkbook).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete Budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete workbook" }));
    expect(deleteWorkbook).toHaveBeenCalledWith("w1");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes the delete dialog on Escape", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Budget" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("creates a workbook and clears the input", async () => {
    renderPage();

    const input = screen.getByLabelText("New workbook name");
    fireEvent.change(input, { target: { value: "Q4 forecast" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workbook" }));

    expect(createWorkbook).toHaveBeenCalledWith({ name: "Q4 forecast" });
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("shows the server's message when creation fails", async () => {
    createWorkbook.mockReturnValue({
      unwrap: () =>
        Promise.reject({
          status: 400,
          data: { error: { code: "VALIDATION_ERROR", message: "name: Too long" } },
        }),
    });
    renderPage();

    fireEvent.change(screen.getByLabelText("New workbook name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workbook" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("name: Too long");
  });

  it("shows empty states", () => {
    workbooks = [];
    renderPage();

    expect(screen.getByText("You don't have any workbooks yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing has been shared with you yet.")).toBeInTheDocument();
  });
});
