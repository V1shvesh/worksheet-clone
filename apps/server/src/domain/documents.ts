import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { yjsDocuments } from "../db/schema.js";

export const SNAPSHOT_INTERVAL_MINUTES = 10;

export async function loadDocumentState(workbookId: string): Promise<Uint8Array | null> {
  const [row] = await db
    .select({ state: yjsDocuments.state })
    .from(yjsDocuments)
    .where(eq(yjsDocuments.workbookId, workbookId))
    .limit(1);
  return row ? new Uint8Array(row.state) : null;
}

function isForeignKeyViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;
  return (error as { code?: string }).code === "23503" || cause?.code === "23503";
}

/**
 * Returns false (instead of throwing) when the workbook no longer exists:
 * a doc still open in memory can be stored after its workbook was deleted.
 */
export async function storeDocumentState(workbookId: string, state: Uint8Array): Promise<boolean> {
  try {
    await db
      .insert(yjsDocuments)
      .values({ workbookId, state: Buffer.from(state) })
      .onConflictDoUpdate({
        target: yjsDocuments.workbookId,
        set: { state: Buffer.from(state), updatedAt: sql`now()` },
      });
    return true;
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return false;
    }
    throw error;
  }
}

/** Inserts a snapshot unless one was taken in the last SNAPSHOT_INTERVAL_MINUTES. */
export async function snapshotIfDue(workbookId: string, state: Uint8Array): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      insert into yjs_snapshots (workbook_id, state)
      select ${workbookId}, ${Buffer.from(state)}
      where not exists (
        select 1 from yjs_snapshots
        where workbook_id = ${workbookId}
          and created_at > now() - make_interval(mins => ${SNAPSHOT_INTERVAL_MINUTES})
      )
    `);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return false;
    }
    throw error;
  }
}
