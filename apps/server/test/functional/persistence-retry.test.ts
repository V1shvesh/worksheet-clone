import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { createEmptyWorkbook } from "@worksheet-clone/shared";
import {
  defaultRetryDelayMs,
  describeStoreError,
  persistenceExtension,
} from "../../src/realtime/persistence.js";

// Drives the extension's hooks directly with a fake Hocuspocus instance, so
// backoff timing can be checked with fake timers. The real Hocuspocus
// unload behavior is covered in collab-save-failure.test.ts.

function setup(storeResults: Array<"fail" | "ok" | "deleted">) {
  const broadcasts: string[] = [];
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  const fakeDoc = Object.assign(doc, {
    broadcastStateless: (payload: string) => broadcasts.push(payload),
    saveMutex: { runExclusive: <T>(fn: () => Promise<T>) => fn() },
  });
  const unloadDocument = vi.fn();
  const instance = {
    documents: new Map([["wb1", fakeDoc]]),
    shouldUnloadDocument: vi.fn(() => true),
    unloadDocument,
  } as unknown as Hocuspocus;

  const attempts: number[] = [];
  let outcomes = [...storeResults];
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const extension = persistenceExtension(log as never, {
    store: async () => {
      attempts.push(Date.now());
      const outcome = outcomes.shift() ?? "ok";
      if (outcome === "fail") throw new Error("connection terminated");
      return outcome === "ok";
    },
    snapshotIfDue: async () => false,
  });
  const store = () =>
    extension.onStoreDocument?.({
      document: fakeDoc,
      documentName: "wb1",
      instance,
    } as never);
  const beforeUnload = () => extension.beforeUnloadDocument?.({ documentName: "wb1" } as never);
  return {
    extension,
    store,
    beforeUnload,
    attempts,
    broadcasts,
    log,
    unloadDocument,
    setOutcomes: (next: Array<"fail" | "ok" | "deleted">) => (outcomes = [...next]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("defaultRetryDelayMs", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(defaultRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("describeStoreError", () => {
  it("never includes the query parameters (the document bytes)", () => {
    const drizzle = Object.assign(
      new Error('Failed query: insert into "yjs_documents"\nparams: secret-cell-content'),
      {
        cause: Object.assign(new Error('relation "yjs_documents" does not exist'), {
          code: "42P01",
        }),
      },
    );
    const described = describeStoreError(drizzle);
    expect(described).toEqual({
      name: "Error",
      code: "42P01",
      reason: 'relation "yjs_documents" does not exist',
    });
    expect(JSON.stringify(describeStoreError(new Error("a\nsecret")))).not.toContain("secret");
  });
});

describe("persistence retry", () => {
  it("retries with 1s, 2s, 4s backoff until the store succeeds", async () => {
    const t = setup(["fail", "fail", "fail", "ok"]);
    const start = Date.now();
    await t.store();
    expect(t.attempts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(t.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.attempts).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(t.attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.attempts).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.attempts).toHaveLength(4);
    expect(t.attempts.map((at) => at - start)).toEqual([0, 1_000, 3_000, 7_000]);

    // Stored: no further retries.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.attempts).toHaveLength(4);
    expect(t.extension.unsavedDocuments()).toEqual([]);
  });

  it("never throws out of onStoreDocument, so Hocuspocus does not log or give up", async () => {
    const t = setup(["fail"]);
    await expect(t.store()).resolves.toBeUndefined();
  });

  it("logs each failure with the workbook id and attempt count", async () => {
    const t = setup(["fail", "fail", "ok"]);
    await t.store();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.log.error).toHaveBeenCalledTimes(2);
    expect(t.log.error.mock.calls.map(([fields]) => [fields.workbookId, fields.attempt])).toEqual([
      ["wb1", 1],
      ["wb1", 2],
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.log.warn).toHaveBeenCalledWith(
      { workbookId: "wb1", attempts: 2, stored: true },
      expect.stringContaining("ended"),
    );
  });

  it("broadcasts saveFailing once and saveRecovered once", async () => {
    const t = setup(["fail", "fail", "fail", "ok"]);
    await t.store();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    expect(t.broadcasts.map((p) => JSON.parse(p).type)).toEqual(["saveFailing"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.broadcasts.map((p) => JSON.parse(p).type)).toEqual(["saveFailing", "saveRecovered"]);
  });

  it("a later failure after recovery notifies again", async () => {
    const t = setup(["fail", "ok"]);
    await t.store();
    await vi.advanceTimersByTimeAsync(1_000);
    t.setOutcomes(["fail", "ok"]);
    await t.store();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.broadcasts.map((p) => JSON.parse(p).type)).toEqual([
      "saveFailing",
      "saveRecovered",
      "saveFailing",
      "saveRecovered",
    ]);
  });

  it("vetoes unloading while the state is unsaved and unloads itself after recovery", async () => {
    const t = setup(["fail", "ok"]);
    await t.store();
    await expect(t.beforeUnload()).rejects.toThrow();
    expect(t.unloadDocument).not.toHaveBeenCalled();

    // The last client is gone, so nothing but our retry can unload it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.unloadDocument).toHaveBeenCalledTimes(1);
    await expect(t.beforeUnload()).resolves.toBeUndefined();
  });

  it("a deleted workbook stops the retry loop without a recovered notice", async () => {
    const t = setup(["fail", "deleted"]);
    await t.store();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.extension.unsavedDocuments()).toEqual([]);
    expect(t.broadcasts.map((p) => JSON.parse(p).type)).toEqual(["saveFailing", "saveRecovered"]);
  });

  it("tells a client that connects during the outage", async () => {
    const t = setup(["fail"]);
    await t.store();
    const sendStateless = vi.fn();
    await t.extension.connected?.({ connection: { sendStateless }, documentName: "wb1" } as never);
    expect(sendStateless).toHaveBeenCalledWith(JSON.stringify({ type: "saveFailing" }));
  });

  it("flushForShutdown makes one last attempt and reports what is still unsaved", async () => {
    const t = setup(["fail", "fail"]);
    await t.store();
    expect(await t.extension.flushForShutdown()).toEqual(["wb1"]);
    t.setOutcomes(["ok"]);
    expect(await t.extension.flushForShutdown()).toEqual([]);
  });
});
