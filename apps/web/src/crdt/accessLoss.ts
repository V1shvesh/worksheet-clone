import { COLLAB_CLOSE_CODES, COLLAB_CLOSE_REASONS } from "@worksheet-clone/shared";
import type { AccessLoss } from "./collabSlice";

export type DeniedKind = Exclude<AccessLoss["kind"], "downgraded" | "tooLarge">;

/**
 * Who the server told us it was when it closed our socket (see COLLAB_CLOSE_REASONS). A refused
 * reconnect alone can't say: the REST lookup 404s for a deleted workbook and for a removed member.
 * No reason (we were offline at the time, or this is the first connect) = we can't tell.
 */
export function deniedKindFromCloseReason(reason: string | undefined): DeniedKind {
  if (reason === COLLAB_CLOSE_REASONS.workbookDeleted) return "deleted";
  if (reason === COLLAB_CLOSE_REASONS.accessChanged) return "removed";
  return "unavailable";
}

export type WorkbookLookup = "missing" | "found" | "failed";

/**
 * After a refused connection, asks REST whether the workbook is still ours. Only a 404 confirms the
 * guess made from the close reason; if the workbook can still be read (or the lookup failed) the
 * socket refusal is unexplained, so the neutral "unavailable" is shown instead of a wrong claim.
 */
export function confirmDeniedKind(guess: DeniedKind, lookup: WorkbookLookup): DeniedKind {
  return lookup === "missing" ? guess : "unavailable";
}

export const ACCESS_LOSS_MESSAGES: Record<AccessLoss["kind"], string> = {
  downgraded: "Your access changed to view only",
  removed: "You no longer have access to this workbook",
  deleted: "This workbook was deleted",
  unavailable: "This workbook is no longer available to you",
  tooLarge: "This workbook reached its size limit (10 MB). Your last change wasn't saved.",
};

/**
 * The server closes the socket with 4413 when a change would push the document past its size cap
 * and drops that change. Retrying would send the same change again, so the client stops instead.
 */
export function isTooLargeClose(event: { code?: number } | undefined): boolean {
  return event?.code === COLLAB_CLOSE_CODES.tooLarge;
}

/**
 * Whether the replica holds changes the server has not confirmed.
 *
 * Why not read `provider.unsyncedChanges` when access drops: the provider resets that counter to 1
 * in startSync() right after the reconnect that follows the 4205 close, i.e. BEFORE the
 * re-authentication answer arrives, so by the time we learn "read-only" the old count is gone.
 * Instead we mark the doc dirty on every update that did not come from the server and clear it
 * when the provider's counter reaches 0 (the server acknowledged everything). The mark also covers
 * edits made between the close and the re-auth, and on-device copies loaded from IndexedDB (which
 * may or may not have reached the server; offering an export is the safe side of that doubt).
 */
export class DirtyTracker {
  private dirty = false;

  /** A document update with this origin: true when it did not come from the server. */
  noteUpdate(origin: unknown, serverOrigin: unknown): void {
    if (origin !== serverOrigin) this.dirty = true;
  }

  /** The provider's unsynced counter changed. */
  noteUnsynced(count: number): void {
    if (count === 0) this.dirty = false;
  }

  get unsaved(): boolean {
    return this.dirty;
  }
}
