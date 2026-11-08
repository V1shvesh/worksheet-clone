import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createEmptyWorkbook, getSheetName, readSheetOrder } from "@worksheet-clone/shared";
import { renameSheet } from "./mutations";
import { cacheDbName, clearUserCaches, clearWorkbookCache, openOfflineCache } from "./offlineCache";
import { createWorkbookUndo } from "./undo";

const names = async () => ((await indexedDB.databases()).map((d) => d.name) as string[]).sort();

async function openDoc(userId: string, workbookId: string, seed = false) {
  const doc = new Y.Doc();
  const cache = openOfflineCache(doc, userId, workbookId);
  if (!cache) throw new Error("expected IndexedDB to be available");
  await cache.whenLoaded;
  if (seed && readSheetOrder(doc).length === 0) createEmptyWorkbook(doc);
  return { doc, cache };
}

afterEach(async () => {
  await clearUserCaches("u1");
  await clearUserCaches("u2");
  localStorage.clear();
});

describe("offline cache", () => {
  it("names the database after the user and workbook", async () => {
    expect(cacheDbName("u1", "w1")).toBe("worksheet:u1:w1");
    const { cache } = await openDoc("u1", "w1");
    expect(await names()).toEqual(["worksheet:u1:w1"]);
    await cache.destroy();
  });

  it("keeps edits made while disconnected, for a fresh doc to load later", async () => {
    const first = await openDoc("u1", "w1", true);
    const sheetId = readSheetOrder(first.doc)[0] ?? "";
    // No provider exists here: this is "offline". The edit only reaches IndexedDB.
    expect(renameSheet(first.doc, false, sheetId, "Typed offline")).toEqual({ ok: true });
    await first.cache.destroy();

    const second = await openDoc("u1", "w1");
    expect(readSheetOrder(second.doc)).toEqual([sheetId]);
    expect(getSheetName(second.doc, sheetId)).toBe("Typed offline");
    await second.cache.destroy();
  });

  it("does not put the loaded content on the undo stack (not LOCAL_ORIGIN)", async () => {
    const first = await openDoc("u1", "w1", true);
    const sheetId = readSheetOrder(first.doc)[0] ?? "";
    renameSheet(first.doc, false, sheetId, "Renamed");
    await first.cache.destroy();

    const doc = new Y.Doc();
    const undo = createWorkbookUndo(doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId: null, selection: null }),
    });
    const cache = openOfflineCache(doc, "u1", "w1");
    await cache?.whenLoaded;
    expect(getSheetName(doc, sheetId)).toBe("Renamed");
    expect(undo.getState().canUndo).toBe(false);

    renameSheet(doc, false, sheetId, "Again");
    expect(undo.getState().canUndo).toBe(true);
    undo.destroy();
    await cache?.destroy();
  });

  it("wipes every database of the user on logout and leaves other users alone", async () => {
    for (const [user, wb] of [
      ["u1", "w1"],
      ["u1", "w2"],
      ["u2", "w1"],
    ] as const) {
      const { cache } = await openDoc(user, wb, true);
      await cache.destroy();
    }
    expect(await names()).toEqual(["worksheet:u1:w1", "worksheet:u1:w2", "worksheet:u2:w1"]);

    await clearUserCaches("u1");
    expect(await names()).toEqual(["worksheet:u2:w1"]);
  });

  it("wipes databases the registry knows even when indexedDB.databases() is unavailable", async () => {
    const { cache } = await openDoc("u1", "w1", true);
    await cache.destroy();
    const original = indexedDB.databases;
    // @ts-expect-error simulating browsers without databases()
    indexedDB.databases = undefined;
    try {
      await clearUserCaches("u1");
    } finally {
      indexedDB.databases = original;
    }
    expect(await names()).toEqual([]);
  });

  it("clearWorkbookCache deletes just that workbook", async () => {
    for (const wb of ["w1", "w2"]) {
      const { cache } = await openDoc("u1", wb, true);
      await cache.destroy();
    }
    await clearWorkbookCache("u1", "w1");
    expect(await names()).toEqual(["worksheet:u1:w2"]);
  });
});
