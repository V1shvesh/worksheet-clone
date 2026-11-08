import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbookSummary } from "@worksheet-clone/shared";

const renameWorkbook = vi.fn();

// Mock the hook modules, not fetch: RTK Query's fetchBaseQuery trips over
// jsdom's AbortController (see docs/failure-log.md).
vi.mock("./workbooksApi", () => ({
  useRenameWorkbookMutation: () => [renameWorkbook, { isLoading: false }],
}));
vi.mock("./MembersDialog", () => ({
  MembersDialog: ({ workbook, onClose }: { workbook: WorkbookSummary; onClose: () => void }) => (
    <div role="dialog" aria-label={`Members of ${workbook.name}`}>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const { createStore } = await import("../../app/store");
const { collabActions } = await import("../../crdt/collabSlice");
const { WorkbookHeader } = await import("./WorkbookHeader");

function wb(role: WorkbookSummary["role"], name = "Q3 budget"): WorkbookSummary {
  const now = new Date().toISOString();
  return { id: "w1", name, role, createdAt: now, updatedAt: now };
}

function renderHeader(workbook: WorkbookSummary) {
  const store = createStore();
  render(
    <Provider store={store}>
      <MemoryRouter>
        <WorkbookHeader workbook={workbook} />
      </MemoryRouter>
    </Provider>,
  );
  return store;
}

const resolved = (value?: unknown) => ({ unwrap: () => Promise.resolve(value) });
const rejected = (message: string) => ({
  unwrap: () => Promise.reject({ status: 403, data: { error: { code: "FORBIDDEN", message } } }),
});

beforeEach(() => renameWorkbook.mockReset().mockReturnValue(resolved()));
afterEach(cleanup);

describe("WorkbookHeader", () => {
  it("links back, shows the role and for non-owners plain text without rename or share", () => {
    renderHeader(wb("editor"));
    expect(screen.getByRole("link", { name: /All workbooks/ })).toHaveAttribute("href", "/");
    expect(screen.getByRole("heading", { name: "Q3 budget" })).toBeInTheDocument();
    expect(screen.getByText("Your role: editor")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename workbook" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });

  it("shows the connection status from the collab state", () => {
    const store = renderHeader(wb("viewer"));
    expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("Offline");
    store.dispatch(collabActions.opened("w1"));
    store.dispatch(collabActions.statusChanged("connected"));
    store.dispatch(collabActions.syncedChanged(true));
    store.dispatch(collabActions.accessChanged("read-only"));
    return waitFor(() =>
      expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent(
        "Live · View only",
      ),
    );
  });

  it("shows the access-denied alert", async () => {
    const store = renderHeader(wb("editor"));
    store.dispatch(collabActions.accessChanged("denied"));
    expect(await screen.findByRole("alert")).toHaveTextContent("don't have access");
  });

  it("owners rename inline: Enter commits the trimmed name", async () => {
    renderHeader(wb("owner"));
    fireEvent.click(screen.getByRole("button", { name: "Rename workbook" }));
    const input = screen.getByLabelText("Workbook name");
    fireEvent.change(input, { target: { value: "  Q4 budget  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(renameWorkbook).toHaveBeenCalledWith({ id: "w1", name: "Q4 budget" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Workbook name")).not.toBeInTheDocument());
  });

  it("blur commits, Escape cancels, an unchanged name sends nothing", async () => {
    renderHeader(wb("owner"));
    fireEvent.click(screen.getByRole("button", { name: "Rename workbook" }));
    fireEvent.change(screen.getByLabelText("Workbook name"), { target: { value: "Nope" } });
    fireEvent.keyDown(screen.getByLabelText("Workbook name"), { key: "Escape" });
    expect(renameWorkbook).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /Q3 budget/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename workbook" }));
    fireEvent.blur(screen.getByLabelText("Workbook name"));
    await waitFor(() => expect(screen.queryByLabelText("Workbook name")).not.toBeInTheDocument());
    expect(renameWorkbook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rename workbook" }));
    fireEvent.change(screen.getByLabelText("Workbook name"), { target: { value: "Blurred" } });
    fireEvent.blur(screen.getByLabelText("Workbook name"));
    await waitFor(() => expect(renameWorkbook).toHaveBeenCalledWith({ id: "w1", name: "Blurred" }));
  });

  it("validates with the shared schema before calling the API", () => {
    renderHeader(wb("owner"));
    fireEvent.click(screen.getByRole("button", { name: "Rename workbook" }));
    const input = screen.getByLabelText("Workbook name");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(renameWorkbook).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Workbook name")).toBeInTheDocument();
  });

  it("keeps the input open and shows a server error", async () => {
    renameWorkbook.mockReturnValue(rejected("You don't have permission to do that"));
    renderHeader(wb("owner"));
    fireEvent.click(screen.getByRole("button", { name: "Rename workbook" }));
    const input = screen.getByLabelText("Workbook name");
    fireEvent.change(input, { target: { value: "Other" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission");
    expect(screen.getByLabelText("Workbook name")).toBeInTheDocument();
  });

  it("owners open the members dialog with Share", () => {
    renderHeader(wb("owner"));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByRole("dialog", { name: "Members of Q3 budget" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
