import type { Extension } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import * as Y from "yjs";
import {
  createEmptyWorkbook,
  ensureWorkbookHasSheet,
  isWorkbookInitialized,
  migrateWorkbook,
} from "@worksheet-clone/shared";
import { loadDocumentState, snapshotIfDue, storeDocumentState } from "../domain/documents.js";

// Origin of the server's own repair transaction. A "local" Hocuspocus origin
// is stored (and broadcast) like any other change.
const REPAIR_ORIGIN = { source: "local" } as const;

export function persistenceExtension(log: FastifyBaseLogger): Extension {
  return {
    extensionName: "postgres-persistence",

    async onLoadDocument({ document, documentName }) {
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
        await storeDocumentState(documentName, Y.encodeStateAsUpdate(document));
      } else if (migrateWorkbook(document)) {
        // Stored for the same reason as the seed: a migration that isn't
        // persisted could be redone with different ids and merge into duplicates.
        await storeDocumentState(documentName, Y.encodeStateAsUpdate(document));
      } else if (ensureWorkbookHasSheet(document, REPAIR_ORIGIN)) {
        log.warn({ workbookId: documentName }, "restored a sheet to a workbook that had none");
        await storeDocumentState(documentName, Y.encodeStateAsUpdate(document));
      }
    },

    // Two editors can concurrently delete the last two sheets; each client
    // allowed it because it still saw another sheet. Only the server repairs
    // that (a repair by every client would add one sheet each). The repair's
    // own transaction fires onChange again, but by then a sheet exists so
    // ensureWorkbookHasSheet writes nothing: no loop. The repair is a normal
    // change, so Hocuspocus broadcasts it and schedules the debounced store.
    async onChange({ document, documentName, transactionOrigin }) {
      if (transactionOrigin === REPAIR_ORIGIN) return;
      if (ensureWorkbookHasSheet(document, REPAIR_ORIGIN)) {
        log.warn({ workbookId: documentName }, "restored a sheet to a workbook that had none");
      }
    },

    async onStoreDocument({ document, documentName }) {
      const state = Y.encodeStateAsUpdate(document);
      const stored = await storeDocumentState(documentName, state);
      if (!stored) {
        log.info({ workbookId: documentName }, "skipped storing a deleted workbook's document");
        return;
      }
      await snapshotIfDue(documentName, state);
    },
  };
}
