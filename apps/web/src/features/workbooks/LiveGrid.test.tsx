import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GridBoundary } from "./LiveGrid";

let renderError: Error | null = null;
function FakeGrid({ sheetId }: { sheetId: string }) {
  if (renderError) throw renderError;
  return <p>grid of {sheetId}</p>;
}
const loadsOk = () => Promise.resolve({ WorkbookGrid: FakeGrid });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  renderError = null;
  vi.restoreAllMocks();
});

describe("GridBoundary", () => {
  it("shows the grid when it loads", async () => {
    render(<GridBoundary sheetId="s1" load={loadsOk} />);
    expect(await screen.findByText("grid of s1")).toBeInTheDocument();
  });

  it("explains a render error and Retry remounts the grid", async () => {
    renderError = new Error("render boom");
    render(<GridBoundary sheetId="s1" load={loadsOk} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the grid");

    renderError = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("grid of s1")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a chunk that fails to load can be retried (a fresh lazy, not React's cached rejection)", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockImplementation(loadsOk);
    render(<GridBoundary sheetId="s1" load={load} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the grid");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("grid of s1")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
