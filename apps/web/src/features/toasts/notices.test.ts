import { describe, expect, it } from "vitest";
import type { CollabNotice } from "@worksheet-clone/shared";
import { noticeToToast } from "./notices";

const by = { userId: "u2", email: "bob@example.com" };
const sheet: CollabNotice = {
  type: "sheetRenamed",
  by,
  sheetId: "s",
  from: "Sheet2",
  to: "Budget",
};
const book: CollabNotice = { type: "workbookRenamed", by, from: "Q3", to: "Q4" };

describe("noticeToToast", () => {
  it("formats a sheet rename with the local part and the email as title", () => {
    expect(noticeToToast(sheet, "u1")).toEqual({
      message: '@bob renamed sheet "Sheet2" to "Budget"',
      title: "bob@example.com",
    });
  });

  it("formats a workbook rename", () => {
    expect(noticeToToast(book, "u1")?.message).toBe('@bob renamed the workbook "Q3" to "Q4"');
  });

  it("drops notices about the signed-in user's own actions", () => {
    expect(noticeToToast(sheet, "u2")).toBeUndefined();
    expect(noticeToToast(book, "u2")).toBeUndefined();
  });

  it("still shows a notice while the current user is unknown", () => {
    expect(noticeToToast(sheet, undefined)).toBeDefined();
  });
});
