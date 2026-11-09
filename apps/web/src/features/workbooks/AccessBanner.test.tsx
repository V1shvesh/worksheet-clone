import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyWorkbook,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
} from "@worksheet-clone/shared";
import { collabActions, type AccessLoss } from "../../crdt/collabSlice";
import { renderWithWorkbook } from "../../test-utils/render-workbook";
import * as recovery from "./recovery-csv";
import { AccessBanner } from "./AccessBanner";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function render(loss: AccessLoss | null, resetDoc?: () => Promise<void>) {
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  const sheetId = readSheetOrder(doc)[0] ?? "";
  setCell(doc, sheetId, readRowOrder(doc, sheetId)[0] ?? "", readColOrder(doc, sheetId)[0] ?? "", {
    v: "mine",
  });
  const view = renderWithWorkbook(<AccessBanner workbookName="Q3 budget" />, {
    doc,
    readOnly: true,
    ...(resetDoc ? { resetDoc } : {}),
  });
  if (loss) act(() => void view.store.dispatch(collabActions.accessLost(loss)));
  return { ...view, doc };
}
const banner = () => screen.getByTestId("access-banner");

describe("AccessBanner", () => {
  it("renders nothing while access is intact", () => {
    render(null);
    expect(screen.queryByTestId("access-banner")).toBeNull();
  });

  it("downgraded without unconfirmed edits: only the notice (nothing to download or reset)", () => {
    render({ kind: "downgraded", unsaved: false });
    expect(banner()).toHaveAttribute("role", "alert");
    expect(banner()).toHaveTextContent("Your access changed to view only");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("downgraded with unconfirmed edits: download the CSVs, then reload to reset the replica", async () => {
    const download = vi.spyOn(recovery, "downloadFiles").mockImplementation(() => undefined);
    const resetDoc = vi.fn(() => Promise.resolve());
    render({ kind: "downgraded", unsaved: true }, resetDoc);
    expect(banner()).toHaveTextContent("Your access changed to view only");

    fireEvent.click(screen.getByRole("button", { name: "Download unsaved changes" }));
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toEqual([
      { fileName: "Q3 budget - Sheet1.csv", content: "﻿mine\r\n" },
    ]);
    expect(resetDoc).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(resetDoc).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["removed", "You no longer have access to this workbook"],
    ["deleted", "This workbook was deleted"],
    ["unavailable", "This workbook is no longer available to you"],
  ] as const)("%s: message and a way back, no reload", (kind, message) => {
    render({ kind, unsaved: false });
    expect(banner()).toHaveTextContent(message);
    expect(screen.getByRole("link", { name: "Back to all workbooks" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("too large: the size-limit message, the CSV download and Reload (no 'back' link)", async () => {
    const download = vi.spyOn(recovery, "downloadFiles").mockImplementation(() => undefined);
    const resetDoc = vi.fn(() => Promise.resolve());
    render({ kind: "tooLarge", unsaved: true }, resetDoc);
    expect(banner()).toHaveTextContent(
      "This workbook reached its size limit (10 MB). Your last change wasn't saved.",
    );
    expect(banner()).not.toHaveTextContent("Some of your latest changes");
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download unsaved changes" }));
    expect(download).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(resetDoc).toHaveBeenCalledTimes(1));
  });

  it("removed with unconfirmed edits offers the download", () => {
    render({ kind: "removed", unsaved: true });
    expect(screen.getByRole("button", { name: "Download unsaved changes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});
