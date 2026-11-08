import type { Awareness } from "y-protocols/awareness";

/** One cell by stable ids (same shape as the grid's `CellId`; kept here so crdt/ doesn't import features/). */
export interface PresenceCell {
  rowId: string;
  colId: string;
}

export interface PresenceSelection {
  anchor: PresenceCell;
  focus: PresenceCell;
}

export interface PresenceUser {
  id: string;
  email: string;
  color: string;
}

/** What each client publishes through awareness. Kept far below the server's 2 KB cap. */
export interface PresenceState {
  user: PresenceUser;
  sheetId: string | null;
  selection: PresenceSelection | null;
}

export interface Peer {
  clientId: number;
  user: PresenceUser;
  sheetId: string | null;
  selection: PresenceSelection | null;
  /** The same user in another tab or window. */
  isSelf: boolean;
}

// Readable with white text on top (initials, name tags) and distinguishable on a white grid.
export const PRESENCE_PALETTE = [
  "#d93025",
  "#e8710a",
  "#b06000",
  "#188038",
  "#0b8043",
  "#007b83",
  "#1a73e8",
  "#5e35b1",
  "#a142f4",
  "#c2185b",
] as const;

/** Deterministic: the same user id has the same color on every client. */
export function colorForUser(userId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PRESENCE_PALETTE[(hash >>> 0) % PRESENCE_PALETTE.length]!;
}

export function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

const isString = (v: unknown): v is string => typeof v === "string";

function parseCell(raw: unknown): PresenceCell | null {
  const cell = raw as Partial<PresenceCell> | null;
  return cell && isString(cell.rowId) && isString(cell.colId)
    ? { rowId: cell.rowId, colId: cell.colId }
    : null;
}

/**
 * Other clients' states are untrusted input (the server only pins the identity), so nothing is
 * used unchecked. The color is recomputed from the id instead of trusted: it ends up in CSS.
 */
export function parsePeerState(raw: unknown): Omit<Peer, "clientId" | "isSelf"> | null {
  const state = raw as Partial<Record<keyof PresenceState, unknown>> | null;
  const user = state?.user as Partial<PresenceUser> | undefined;
  if (!user || !isString(user.id) || !isString(user.email)) return null;
  const anchor = parseCell((state?.selection as Partial<PresenceSelection> | null)?.anchor);
  const focus = parseCell((state?.selection as Partial<PresenceSelection> | null)?.focus);
  return {
    user: { id: user.id, email: user.email, color: colorForUser(user.id) },
    sheetId: isString(state?.sheetId) ? state.sheetId : null,
    selection: anchor && focus ? { anchor, focus } : null,
  };
}

/** Every other client currently in the workbook (this client's own state excluded). */
export function readPeers(awareness: Awareness, selfUserId: string | undefined): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, raw] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const parsed = parsePeerState(raw);
    if (parsed) peers.push({ clientId, ...parsed, isSelf: parsed.user.id === selfUserId });
  }
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/** One entry per user (avatars); a user with several tabs shows once. */
export function uniquePeersByUser(peers: readonly Peer[]): Peer[] {
  const seen = new Set<string>();
  return peers.filter((peer) => {
    if (seen.has(peer.user.id)) return false;
    seen.add(peer.user.id);
    return true;
  });
}

export const PRESENCE_INTERVAL_MS = 100;

export interface PresencePublisher {
  /** Publishes now if the last publish was long enough ago, otherwise the latest value goes out trailing. */
  update(sheetId: string | null, selection: PresenceSelection | null): void;
  destroy(): void;
}

function stripSelection(selection: PresenceSelection | null): PresenceSelection | null {
  // The grid's selection may carry undo hints; only the ids are shared.
  return (
    selection && {
      anchor: { rowId: selection.anchor.rowId, colId: selection.anchor.colId },
      focus: { rowId: selection.focus.rowId, colId: selection.focus.colId },
    }
  );
}

/** Publishes this client's state, at most `PRESENCE_INTERVAL_MS` apart (≤10/s). */
export function createPresencePublisher(
  awareness: Awareness,
  identity: { id: string; email: string },
): PresencePublisher {
  const user: PresenceUser = { ...identity, color: colorForUser(identity.id) };
  let current: PresenceState = { user, sheetId: null, selection: null };
  let lastPublished = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const publish = () => {
    timer = null;
    // After `provider.destroy()` the local state is null; writing would announce us again.
    if (destroyed || awareness.getLocalState() === null) return;
    lastPublished = Date.now();
    awareness.setLocalState(current);
  };

  publish();

  return {
    update(sheetId, selection) {
      current = { user, sheetId, selection: stripSelection(selection) };
      if (timer !== null) return;
      const wait = lastPublished + PRESENCE_INTERVAL_MS - Date.now();
      if (wait <= 0) publish();
      else timer = setTimeout(publish, wait);
    },
    destroy() {
      destroyed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** A tiny external store over awareness `change`, with a stable snapshot between changes. */
export function createPeersStore(awareness: Awareness, selfUserId: string | undefined) {
  let snapshot = readPeers(awareness, selfUserId);
  return {
    getSnapshot: () => snapshot,
    subscribe(onChange: () => void) {
      // Awareness may have changed between creating the store and subscribing.
      snapshot = readPeers(awareness, selfUserId);
      const listener = () => {
        snapshot = readPeers(awareness, selfUserId);
        onChange();
      };
      awareness.on("change", listener);
      return () => awareness.off("change", listener);
    },
  };
}
