import type { Extension, Hocuspocus } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import * as Y from "yjs";
import {
  createEmptyWorkbook,
  ensureWorkbookHasSheet,
  isWorkbookInitialized,
  migrateWorkbook,
  type CollabNotice,
} from "@worksheet-clone/shared";
import { describeDbError } from "../logging.js";
import {
  loadDocumentState,
  snapshotIfDue as defaultSnapshotIfDue,
  storeDocumentState as defaultStoreDocumentState,
} from "../domain/documents.js";

// Origin of the server's own repair transaction. A "local" Hocuspocus origin
// is stored (and broadcast) like any other change.
const REPAIR_ORIGIN = { source: "local" } as const;

/** Seams for tests: inject a failing store, or short retry delays. */
export interface PersistenceOptions {
  store?: (workbookId: string, state: Uint8Array) => Promise<boolean>;
  snapshotIfDue?: (workbookId: string, state: Uint8Array) => Promise<boolean>;
  /** Delay before retry number `attempt` (1-based) after a failed store. */
  retryDelayMs?: (attempt: number) => number;
}

/** 1s, 2s, 4s, ... capped at 30s. */
export function defaultRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 30_000);
}

export interface PersistenceExtension extends Extension {
  /**
   * Shutdown: one last store attempt for every document whose latest state
   * isn't in Postgres. Resolves with the ids that still could not be stored.
   */
  flushForShutdown(): Promise<string[]>;
  /** Workbook ids held in memory with changes that are not stored yet. */
  unsavedDocuments(): string[];
}

interface Unsaved {
  attempts: number;
  /** saveFailing was broadcast and saveRecovered has not been yet. */
  notified: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/*
 * How Hocuspocus 4.8 treats a failing store (read in
 * @hocuspocus/server/src/Hocuspocus.ts, storeDocumentHooks / handleConnection /
 * unloadDocument):
 *  - An onStoreDocument error is caught, logged with console.error ("Document
 *    stays in memory to avoid data loss") and NOT retried: no debounce is
 *    left, so nothing stores the document again until the next edit.
 *  - Last disconnect: if a store is debounced it runs at once (unloadImmediately);
 *    otherwise the document is unloaded immediately. shouldUnloadDocument only
 *    looks at the debouncer, the save mutex and the connection count, so
 *    after a failed store a LATER last-disconnect would unload the document
 *    and silently lose the unsaved state.
 *  - unloadDocument runs the beforeUnloadDocument hook first and aborts when
 *    it throws (the error is swallowed and the document stays loaded).
 * So this extension never lets a store error escape: it records the document
 * as unsaved, retries on its own timer with backoff, and vetoes unloading in
 * beforeUnloadDocument until a store succeeds. Hocuspocus then sees a
 * successful store and runs its normal unload check; if the last client left
 * during the outage, the successful retry unloads the document itself.
 */
export function persistenceExtension(
  log: FastifyBaseLogger,
  options: PersistenceOptions = {},
): PersistenceExtension {
  const store = options.store ?? defaultStoreDocumentState;
  const snapshotIfDue = options.snapshotIfDue ?? defaultSnapshotIfDue;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const unsaved = new Map<string, Unsaved>();
  let instance: Hocuspocus | undefined;

  function broadcast(workbookId: string, notice: CollabNotice): void {
    instance?.documents.get(workbookId)?.broadcastStateless(JSON.stringify(notice));
  }

  function clear(workbookId: string): Unsaved | undefined {
    const entry = unsaved.get(workbookId);
    if (entry?.timer) clearTimeout(entry.timer);
    unsaved.delete(workbookId);
    return entry;
  }

  function scheduleRetry(workbookId: string, entry: Unsaved): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void retry(workbookId);
    }, retryDelayMs(entry.attempts));
    // A pending retry must not keep a stopping process alive; shutdown makes
    // its own last attempt (flushForShutdown).
    entry.timer.unref?.();
  }

  /** Stores the document's current state. Never throws; failures go to the retry loop. */
  async function save(workbookId: string, state: Uint8Array): Promise<void> {
    let stored: boolean;
    try {
      stored = await store(workbookId, state);
    } catch (error) {
      const entry = unsaved.get(workbookId) ?? { attempts: 0, notified: false };
      unsaved.set(workbookId, entry);
      entry.attempts += 1;
      log.error(
        { err: describeDbError(error), workbookId, attempt: entry.attempts },
        "storing a workbook document failed; keeping it in memory and retrying",
      );
      if (!entry.notified) {
        entry.notified = true;
        broadcast(workbookId, { type: "saveFailing" });
      }
      scheduleRetry(workbookId, entry);
      return;
    }

    const entry = clear(workbookId);
    if (entry) {
      log.warn(
        { workbookId, attempts: entry.attempts, stored },
        "retrying a workbook document store ended",
      );
      // Also when the workbook was deleted meanwhile: nothing is left to
      // save, so a "saving failed" banner must not stay up.
      if (entry.notified) broadcast(workbookId, { type: "saveRecovered" });
    }
    if (!stored) {
      log.info({ workbookId }, "skipped storing a deleted workbook's document");
      return;
    }
    try {
      await snapshotIfDue(workbookId, state);
    } catch (error) {
      // The document itself is stored; a missed snapshot is not data loss.
      log.warn({ err: error, workbookId }, "storing a workbook snapshot failed");
    }
  }

  async function retry(workbookId: string): Promise<void> {
    const document = instance?.documents.get(workbookId);
    if (!document || !instance) {
      clear(workbookId);
      return;
    }
    await document.saveMutex.runExclusive(() => save(workbookId, Y.encodeStateAsUpdate(document)));
    // The last client may have left during the outage: nothing else will
    // trigger the unload Hocuspocus skipped, so do it now.
    if (!unsaved.has(workbookId) && instance.shouldUnloadDocument(document)) {
      void instance.unloadDocument(document);
    }
  }

  return {
    extensionName: "postgres-persistence",

    async onLoadDocument({ document, documentName, instance: hocuspocus }) {
      instance = hocuspocus;
      log.info({ workbookId: documentName }, "workbook document loading");
      const state = await loadDocumentState(documentName);
      if (state) {
        Y.applyUpdate(document, state);
      }

      // The server is the only place a workbook's structure is created. The
      // seed is stored right away: if it weren't, a visitor who left without
      // editing would leave nothing behind, the next load would seed a
      // different sheet id, and any client still holding the first one
      // would merge both into two "Sheet1"s.
      if (!isWorkbookInitialized(document)) {
        createEmptyWorkbook(document);
        await store(documentName, Y.encodeStateAsUpdate(document));
      } else if (migrateWorkbook(document)) {
        // Stored for the same reason as the seed: a migration that isn't
        // persisted could be redone with different ids and merge into duplicates.
        await store(documentName, Y.encodeStateAsUpdate(document));
      } else if (ensureWorkbookHasSheet(document, REPAIR_ORIGIN)) {
        log.warn({ workbookId: documentName }, "restored a sheet to a workbook that had none");
        await store(documentName, Y.encodeStateAsUpdate(document));
      }
    },

    // Two editors can concurrently delete the last two sheets; each client
    // allowed it because it still saw another sheet. Only the server repairs
    // that (a repair by every client would add one sheet each). The repair's
    // own transaction fires onChange again, but by then a sheet exists so
    // ensureWorkbookHasSheet writes nothing: no loop. The repair is a normal
    // change, so Hocuspocus broadcasts it and schedules the debounced store.
    async onChange({ document, documentName, transactionOrigin, instance: hocuspocus }) {
      instance = hocuspocus;
      if (transactionOrigin === REPAIR_ORIGIN) return;
      if (ensureWorkbookHasSheet(document, REPAIR_ORIGIN)) {
        log.warn({ workbookId: documentName }, "restored a sheet to a workbook that had none");
      }
    },

    // A client that joins during an outage should know saving is failing.
    async connected({ connection, documentName }) {
      if (unsaved.get(documentName)?.notified) {
        connection.sendStateless(JSON.stringify({ type: "saveFailing" } satisfies CollabNotice));
      }
    },

    async onStoreDocument({ document, documentName, instance: hocuspocus }) {
      instance = hocuspocus;
      await save(documentName, Y.encodeStateAsUpdate(document));
    },

    // Veto (see the comment above): an empty message keeps Hocuspocus from
    // console.error-ing a routine decision.
    async beforeUnloadDocument({ documentName }) {
      if (unsaved.has(documentName)) {
        throw new Error("");
      }
    },

    async afterUnloadDocument({ documentName }) {
      clear(documentName);
      log.info({ workbookId: documentName }, "workbook document unloaded");
    },

    unsavedDocuments: () => [...unsaved.keys()],

    async flushForShutdown() {
      const names = [...unsaved.keys()];
      await Promise.all(
        names.map(async (workbookId) => {
          const entry = unsaved.get(workbookId);
          if (entry?.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
          }
          const document = instance?.documents.get(workbookId);
          if (!document) return;
          await document.saveMutex.runExclusive(() =>
            save(workbookId, Y.encodeStateAsUpdate(document)),
          );
        }),
      );
      return [...unsaved.keys()];
    },
  };
}
