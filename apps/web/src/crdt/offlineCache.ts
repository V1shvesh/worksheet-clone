import { IndexeddbPersistence, clearDocument } from "y-indexeddb";
import type * as Y from "yjs";

/**
 * The on-device copy of a workbook's Y.Doc (y-indexeddb), so edits survive going offline and
 * closing the tab before the server has them.
 *
 * Why merging the cache is always safe: it only ever holds Yjs updates of THIS workbook's own
 * document (the database name contains the workbook id, and ids are never reused), so loading it
 * is just receiving updates this doc has already seen or is a causal prefix/extension of. Yjs
 * merges those idempotently with whatever the server sends; a server-side schema migration or a
 * collaborator's edits arrive as further updates on top. Nothing from another user can be in it
 * (the name also contains the user id, and logout deletes it).
 *
 * Launching the app offline is not supported (the page itself isn't cached): the cache is a
 * safety net for edits, not an offline mode.
 */

const PREFIX = "worksheet";
const REGISTRY_KEY = "worksheet:cache-registry";

export function cacheDbName(userId: string, workbookId: string): string {
  return `${PREFIX}:${userId}:${workbookId}`;
}

/** Whether this browser can persist at all (false in jsdom without fake-indexeddb, some private modes). */
export function offlineCacheAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

// A small localStorage registry of database names: indexedDB.databases() is missing in older
// browsers (Firefox before 126), so it's a fallback for enumerating what to wipe on logout.
function readRegistry(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function writeRegistry(names: string[]): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify([...new Set(names)]));
  } catch {
    // Storage blocked or full: wiping then relies on indexedDB.databases() alone.
  }
}

async function knownDatabaseNames(): Promise<string[]> {
  const names = readRegistry();
  try {
    const listed = await indexedDB.databases?.();
    for (const db of listed ?? []) if (db.name) names.push(db.name);
  } catch {
    // databases() unsupported or rejected: the registry is all we have.
  }
  return [...new Set(names)];
}

export interface OfflineCache {
  /** Resolves once the stored updates have been applied to the doc. */
  whenLoaded: Promise<void>;
  /** Stops persisting and closes the database (resolves once it is closed). */
  destroy(): Promise<void>;
}

/**
 * Starts persisting `doc` under the user's/workbook's database. The stored updates are applied
 * with the persistence object as the transaction origin, i.e. never LOCAL_ORIGIN, so the undo
 * manager does not record them and a reload doesn't start with an undo history.
 * Returns null when IndexedDB isn't usable; the app then works as before, just without the cache.
 */
export function openOfflineCache(
  doc: Y.Doc,
  userId: string,
  workbookId: string,
): OfflineCache | null {
  if (!offlineCacheAvailable()) return null;
  const name = cacheDbName(userId, workbookId);
  try {
    writeRegistry([...readRegistry(), name]);
    const persistence = new IndexeddbPersistence(name, doc);
    // Opening can fail asynchronously (private mode, quota); that must not become an unhandled rejection.
    const opened = persistence._db.then(
      () => true,
      () => false,
    );
    return {
      whenLoaded: opened.then((ok) =>
        ok ? persistence.whenSynced.then(() => undefined) : undefined,
      ),
      destroy: () => persistence.destroy().catch(() => undefined),
    };
  } catch {
    return null;
  }
}

/** Deletes one workbook's on-device copy (access lost, workbook deleted). */
export async function clearWorkbookCache(userId: string, workbookId: string): Promise<void> {
  if (!offlineCacheAvailable()) return;
  const name = cacheDbName(userId, workbookId);
  writeRegistry(readRegistry().filter((n) => n !== name));
  await clearDocument(name).catch(() => undefined);
}

/** Deletes every on-device workbook copy of a user (logout). */
export async function clearUserCaches(userId: string): Promise<void> {
  if (!offlineCacheAvailable()) return;
  const mine = `${PREFIX}:${userId}:`;
  const names = (await knownDatabaseNames()).filter((n) => n.startsWith(mine));
  writeRegistry(readRegistry().filter((n) => !n.startsWith(mine)));
  await Promise.all(names.map((n) => clearDocument(n).catch(() => undefined)));
}
