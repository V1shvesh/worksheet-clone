import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import {
  PRESENCE_PALETTE,
  colorForUser,
  createPeersStore,
  createPresencePublisher,
  parsePeerState,
  readPeers,
  uniquePeersByUser,
  type Peer,
} from "./presence";

const ALICE = { id: "u-alice", email: "alice@example.com" };
const BOB = { id: "u-bob", email: "bob@example.com" };
const cell = (rowId: string, colId: string) => ({ rowId, colId });

interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

/** Two awareness instances wired like a server relay (updates flow both ways). */
function connectedPair() {
  const a = new Awareness(new Y.Doc());
  const b = new Awareness(new Y.Doc());
  const relay = (from: Awareness, to: Awareness) =>
    from.on("update", ({ added, updated, removed }: AwarenessChanges, origin: unknown) => {
      if (origin === "remote") return;
      const clients = [...added, ...updated, ...removed];
      applyAwarenessUpdate(to, encodeAwarenessUpdate(from, clients), "remote");
    });
  relay(a, b);
  relay(b, a);
  return { a, b };
}

describe("colorForUser", () => {
  it("is deterministic and drawn from the palette", () => {
    expect(colorForUser("u-1")).toBe(colorForUser("u-1"));
    expect(PRESENCE_PALETTE).toContain(colorForUser("u-1"));
  });

  it("spreads different users over several colors", () => {
    const colors = new Set(Array.from({ length: 50 }, (_, i) => colorForUser(`user-${i}`)));
    expect(colors.size).toBeGreaterThan(5);
  });
});

describe("parsePeerState", () => {
  it("recomputes the color instead of trusting the published one", () => {
    const peer = parsePeerState({
      user: { id: "u-1", email: "a@b.c", color: "red; background: url(x)" },
      sheetId: "s1",
      selection: null,
    });
    expect(peer?.user.color).toBe(colorForUser("u-1"));
  });

  it("rejects states without a usable user and ignores malformed selections", () => {
    expect(parsePeerState(null)).toBeNull();
    expect(parsePeerState({})).toBeNull();
    expect(parsePeerState({ user: { id: 1, email: "x" } })).toBeNull();
    const peer = parsePeerState({
      user: { id: "u", email: "e" },
      sheetId: 7,
      selection: { anchor: { rowId: "r" }, focus: cell("r", "c") },
    });
    expect(peer).toMatchObject({ sheetId: null, selection: null });
  });
});

describe("presence publisher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("publishes the user at once and the sheet + selection as they change", () => {
    const { a, b } = connectedPair();
    const publisher = createPresencePublisher(a, ALICE);
    expect(readPeers(b, undefined)).toHaveLength(1);
    expect(readPeers(b, undefined)[0]).toMatchObject({
      user: { id: ALICE.id, email: ALICE.email, color: colorForUser(ALICE.id) },
      sheetId: null,
      selection: null,
    });

    vi.advanceTimersByTime(150);
    publisher.update("s1", { anchor: cell("r1", "c1"), focus: cell("r2", "c2") });
    expect(readPeers(b, undefined)[0]).toMatchObject({
      sheetId: "s1",
      selection: { anchor: cell("r1", "c1"), focus: cell("r2", "c2") },
    });
    publisher.destroy();
  });

  it("never publishes the undo hint and stays far under the server's 2 KB cap", () => {
    const { a } = connectedPair();
    const publisher = createPresencePublisher(a, ALICE);
    vi.advanceTimersByTime(150);
    publisher.update("s1", {
      anchor: cell("row-id-xxxxxxxx", "col-id-xxxxxxxx"),
      focus: cell("row-id-yyyyyyyy", "col-id-yyyyyyyy"),
      hint: { anchor: { row: 1, col: 1 }, focus: { row: 2, col: 2 } },
    } as never);
    const json = JSON.stringify(a.getLocalState());
    expect(json).not.toContain("hint");
    expect(json.length).toBeLessThan(500);
  });

  it("publishes at most 10 times a second and the last value always wins", () => {
    const { a } = connectedPair();
    const publish = vi.fn();
    a.on("update", publish);
    const publisher = createPresencePublisher(a, ALICE);
    vi.advanceTimersByTime(150);
    publish.mockClear();

    for (let i = 0; i < 50; i += 1) {
      publisher.update("s1", { anchor: cell(`r${i}`, "c"), focus: cell(`r${i}`, "c") });
      vi.advanceTimersByTime(10); // 50 moves in 500 ms
    }
    vi.advanceTimersByTime(200);
    expect(publish.mock.calls.length).toBeLessThanOrEqual(6);
    expect(
      (a.getLocalState() as { selection: { anchor: { rowId: string } } }).selection.anchor,
    ).toEqual(cell("r49", "c"));
  });

  it("does not re-announce a client whose awareness was destroyed", () => {
    const { a } = connectedPair();
    const publisher = createPresencePublisher(a, ALICE);
    vi.advanceTimersByTime(150);
    publisher.update("s1", null);
    publisher.update("s2", null); // trailing publish pending
    a.destroy();
    vi.advanceTimersByTime(500);
    expect(a.getLocalState()).toBeNull();
    publisher.destroy();
  });
});

describe("readPeers and the peers store", () => {
  it("excludes this client, flags the same user's other tabs and drops departed peers", () => {
    const { a, b } = connectedPair();
    createPresencePublisher(a, ALICE);
    createPresencePublisher(b, ALICE); // alice, second tab

    const seenByA = readPeers(a, ALICE.id);
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]).toMatchObject({ clientId: b.clientID, isSelf: true });

    removeAwarenessStates(b, [b.clientID], "test");
    expect(readPeers(a, ALICE.id)).toEqual([]);
  });

  it("notifies subscribers on change with a stable snapshot in between", () => {
    const { a, b } = connectedPair();
    const store = createPeersStore(a, ALICE.id);
    const onChange = vi.fn();
    const off = store.subscribe(onChange);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);

    createPresencePublisher(b, BOB);
    expect(onChange).toHaveBeenCalled();
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]?.isSelf).toBe(false);
    off();
  });
});

describe("uniquePeersByUser", () => {
  it("keeps the first tab of each user", () => {
    const peer = (clientId: number, id: string): Peer => ({
      clientId,
      user: { id, email: `${id}@x`, color: "#000" },
      sheetId: null,
      selection: null,
      isSelf: false,
    });
    const unique = uniquePeersByUser([peer(1, "a"), peer(2, "b"), peer(3, "a")]);
    expect(unique.map((p) => p.clientId)).toEqual([1, 2]);
  });
});
