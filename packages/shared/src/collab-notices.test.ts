import { describe, expect, it } from "vitest";
import { parseCollabNotice, type CollabNotice } from "./collab-notices.js";

const by = { userId: "u1", email: "bob@example.com" };

describe("parseCollabNotice", () => {
  it("round-trips both notice types", () => {
    const notices: CollabNotice[] = [
      { type: "workbookRenamed", by, from: "Old", to: "New" },
      { type: "sheetRenamed", by, sheetId: "s1", from: "Sheet2", to: "Budget" },
      { type: "saveFailing" },
      { type: "saveRecovered" },
    ];
    for (const notice of notices) {
      expect(parseCollabNotice(JSON.stringify(notice))).toEqual(notice);
    }
  });

  it("returns undefined for malformed or unknown payloads without throwing", () => {
    for (const payload of [
      "",
      "not json",
      "null",
      "42",
      "{}",
      JSON.stringify({ type: "other", by, from: "a", to: "b" }),
      JSON.stringify({ type: "workbookRenamed", from: "a", to: "b" }),
      JSON.stringify({ type: "sheetRenamed", by, from: "a", to: "b" }),
      JSON.stringify({ type: "saveFailing", extra: 1 }).slice(0, -3),
    ]) {
      expect(parseCollabNotice(payload)).toBeUndefined();
    }
  });
});
