import type { Extension } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import * as Y from "yjs";
import {
  createEmptyWorkbook,
  isWorkbookInitialized,
  migrateWorkbook,
} from "@worksheet-clone/shared";
import { loadDocumentState, snapshotIfDue, storeDocumentState } from "../domain/documents.js";

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
