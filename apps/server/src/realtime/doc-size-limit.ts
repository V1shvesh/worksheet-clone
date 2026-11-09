import type { Extension } from "@hocuspocus/server";
import { COLLAB_CLOSE_CODES, COLLAB_CLOSE_REASONS } from "@worksheet-clone/shared";
import type { FastifyBaseLogger } from "fastify";
import * as Y from "yjs";

// Hocuspocus message types and y-protocols sync sub-types (the numeric values
// are part of the wire protocol).
const MESSAGE_SYNC = 0;
const MESSAGE_SYNC_REPLY = 4;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

/** Thrown to stop Hocuspocus handling the rest of a message; empty message so it isn't console.error'd. */
export class DocTooLargeError extends Error {
  constructor() {
    super("");
  }
}

function readVarUint(bytes: Uint8Array, position: number): [value: number, next: number] | null {
  let value = 0;
  let shift = 0;
  for (let index = position; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, index + 1];
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

/**
 * Pulls the Yjs update out of a raw Hocuspocus frame
 * (varString address, varUint type, then for sync frames varUint subtype and a
 * varUint8Array). Returns null for anything that can't change the document
 * (awareness, auth, stateless, sync step 1) or that doesn't parse; the real
 * handler deals with malformed frames.
 */
export function extractDocUpdate(frame: Uint8Array): Uint8Array | null {
  const addressLength = readVarUint(frame, 0);
  if (!addressLength) return null;
  const type = readVarUint(frame, addressLength[0] + addressLength[1]);
  if (!type || (type[0] !== MESSAGE_SYNC && type[0] !== MESSAGE_SYNC_REPLY)) return null;
  const subtype = readVarUint(frame, type[1]);
  if (!subtype || (subtype[0] !== SYNC_STEP2 && subtype[0] !== SYNC_UPDATE)) return null;
  const length = readVarUint(frame, subtype[1]);
  if (!length) return null;
  return frame.subarray(length[1], length[1] + length[0]);
}

function currentSize(document: Y.Doc): number {
  return Y.encodeStateAsUpdate(document).byteLength;
}

/** Exact encoded size the document would have after `update`, computed on a throwaway copy. */
function sizeAfter(document: Y.Doc, update: Uint8Array): number {
  const staged = new Y.Doc();
  try {
    Y.applyUpdate(staged, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(staged, update);
    return currentSize(staged);
  } finally {
    staged.destroy();
  }
}

export interface DocSizeLimitOptions {
  docBytes: number;
}

/*
 * A CRDT cannot "reject" an update once it is applied and broadcast, so this
 * checks BEFORE Hocuspocus applies one (beforeHandleMessage):
 *
 *  1. Cheap path: keep a running estimate of the document's encoded size (exact
 *     at first sight, then + each applied update's byte length, which slightly
 *     overestimates because deletions and merged structs compress). While
 *     estimate + incoming update <= cap, nothing is measured.
 *  2. Otherwise measure the live document exactly; still fits -> allow.
 *  3. Otherwise apply the update to a throwaway copy and measure that. Allow it
 *     when the result fits OR the document does not grow (so a user at the cap can
 *     always delete their way out); else refuse.
 *
 * Refusing means: the update is never applied, never broadcast to collaborators and
 * never stored; the sender's socket is closed with 4413 "too-large". The sender's
 * own browser still holds the update in its local Y.Doc (and on-device cache); the
 * server cannot undo that, and a provider that reconnects re-sends it and is
 * refused again, so the client must stop reconnecting on 4413 (M9 web track).
 * Measuring costs O(document) but only runs for documents within one update of
 * the cap. Read-only connections are skipped: their updates are dropped anyway.
 */
export function docSizeLimitExtension(
  log: FastifyBaseLogger,
  options: DocSizeLimitOptions,
): Extension {
  const cap = options.docBytes;
  const estimates = new Map<string, number>();

  return {
    extensionName: "doc-size-limit",

    async beforeHandleMessage({ connection, document, documentName, update: frame }) {
      if (connection.readOnly) return;
      const update = extractDocUpdate(frame);
      if (!update) return;

      let estimate = estimates.get(documentName);
      if (estimate === undefined) {
        estimate = currentSize(document);
        estimates.set(documentName, estimate);
      }
      if (estimate + update.byteLength <= cap) return;

      const exact = currentSize(document);
      estimates.set(documentName, exact);
      if (exact + update.byteLength <= cap) return;

      const after = sizeAfter(document, update);
      if (after <= cap || after <= exact) return;

      log.warn(
        {
          workbookId: documentName,
          userId: (connection.context as { userId?: string } | undefined)?.userId,
          docBytes: exact,
          updateBytes: update.byteLength,
          wouldBeBytes: after,
          capBytes: cap,
        },
        "refused an update that would push a workbook past its size cap",
      );
      connection.webSocket.close(COLLAB_CLOSE_CODES.tooLarge, COLLAB_CLOSE_REASONS.tooLarge);
      throw new DocTooLargeError();
    },

    async onChange({ documentName, update }) {
      const estimate = estimates.get(documentName);
      if (estimate !== undefined) estimates.set(documentName, estimate + update.byteLength);
    },

    async afterUnloadDocument({ documentName }) {
      estimates.delete(documentName);
    },
  };
}
