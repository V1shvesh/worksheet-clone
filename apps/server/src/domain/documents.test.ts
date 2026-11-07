import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { cleanupByEmailPattern, createUser, testEmails } from "../../test/helpers/db.js";
import { loadDocumentState, snapshotIfDue, storeDocumentState } from "./documents.js";
import { createWorkbook, deleteWorkbook } from "./workbooks.js";

const emails = testEmails("test-domain-docs");

afterEach(() => cleanupByEmailPattern(emails.pattern));
afterAll(() => pool.end());

async function newWorkbook() {
  const owner = await createUser(emails.next());
  return { owner, workbook: await createWorkbook(owner.id, "Doc") };
}

async function snapshotCount(workbookId: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as n from yjs_snapshots where workbook_id = ${workbookId}`,
  );
  return (result.rows[0] as { n: number }).n;
}

describe("document state", () => {
  it("returns null before anything is stored, then round-trips bytes", async () => {
    const { workbook } = await newWorkbook();
    expect(await loadDocumentState(workbook.id)).toBeNull();

    expect(await storeDocumentState(workbook.id, new Uint8Array([1, 2, 255]))).toBe(true);
    expect(await loadDocumentState(workbook.id)).toEqual(new Uint8Array([1, 2, 255]));

    expect(await storeDocumentState(workbook.id, new Uint8Array([9]))).toBe(true);
    expect(await loadDocumentState(workbook.id)).toEqual(new Uint8Array([9]));
  });

  it("skips storing for a deleted workbook instead of throwing", async () => {
    const { owner, workbook } = await newWorkbook();
    await deleteWorkbook(owner.id, workbook.id);

    expect(await storeDocumentState(workbook.id, new Uint8Array([1]))).toBe(false);
    expect(await snapshotIfDue(workbook.id, new Uint8Array([1]))).toBe(false);
  });
});

describe("snapshots", () => {
  it("takes at most one snapshot per interval", async () => {
    const { workbook } = await newWorkbook();

    expect(await snapshotIfDue(workbook.id, new Uint8Array([1]))).toBe(true);
    expect(await snapshotIfDue(workbook.id, new Uint8Array([2]))).toBe(false);
    expect(await snapshotCount(workbook.id)).toBe(1);

    await db.execute(
      sql`update yjs_snapshots set created_at = now() - interval '11 minutes' where workbook_id = ${workbook.id}`,
    );
    expect(await snapshotIfDue(workbook.id, new Uint8Array([3]))).toBe(true);
    expect(await snapshotCount(workbook.id)).toBe(2);
  });
});
