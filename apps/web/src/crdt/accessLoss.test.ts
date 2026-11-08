import { describe, expect, it } from "vitest";
import { confirmDeniedKind, deniedKindFromCloseReason, DirtyTracker } from "./accessLoss";

describe("deniedKindFromCloseReason", () => {
  it.each([
    ["workbook-deleted", "deleted"],
    ["access-changed", "removed"],
    ["", "unavailable"],
    [undefined, "unavailable"],
    ["network lost", "unavailable"],
  ] as const)("%j -> %s", (reason, kind) => {
    expect(deniedKindFromCloseReason(reason)).toBe(kind);
  });
});

describe("confirmDeniedKind", () => {
  it("keeps the guess only when REST says the workbook is gone for us", () => {
    expect(confirmDeniedKind("deleted", "missing")).toBe("deleted");
    expect(confirmDeniedKind("removed", "missing")).toBe("removed");
    expect(confirmDeniedKind("removed", "found")).toBe("unavailable");
    expect(confirmDeniedKind("deleted", "failed")).toBe("unavailable");
  });
});

describe("DirtyTracker", () => {
  const server = Symbol("server");
  it("is dirty after a local update and clean once the server acknowledged everything", () => {
    const tracker = new DirtyTracker();
    expect(tracker.unsaved).toBe(false);
    tracker.noteUpdate(server, server);
    expect(tracker.unsaved).toBe(false);
    tracker.noteUpdate("local", server);
    expect(tracker.unsaved).toBe(true);
    tracker.noteUnsynced(2);
    expect(tracker.unsaved).toBe(true);
    tracker.noteUnsynced(0);
    expect(tracker.unsaved).toBe(false);
  });

  it("stays dirty when the reconnect handshake resets the counter to 1 and nothing acks it", () => {
    const tracker = new DirtyTracker();
    tracker.noteUpdate("local", server);
    tracker.noteUnsynced(1);
    expect(tracker.unsaved).toBe(true);
  });
});
