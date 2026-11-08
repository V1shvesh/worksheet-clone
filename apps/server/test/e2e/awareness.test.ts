import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeAwarenessStates } from "y-protocols/awareness";
import type { WorkbookSummary } from "@worksheet-clone/shared";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { HttpUser, startStack, type Stack } from "./stack.js";

let stack: Stack;
const clients: CollabClient[] = [];

beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterEach(() => {
  clients.splice(0).forEach((client) => client.destroy());
});
afterAll(() => stack?.stop());

let count = 0;
async function newUser(name: string): Promise<HttpUser & { id: string }> {
  const user = new HttpUser(stack, `e2e-awareness-${name}-${++count}@example.com`);
  await user.signup();
  const me = await user.request("GET", "/api/auth/me");
  const { user: profile } = (await me.json()) as { user: { id: string } };
  return Object.assign(user, { id: profile.id });
}

async function setup() {
  const alice = await newUser("alice");
  const bob = await newUser("bob");
  const vera = await newUser("vera");
  const created = await alice.request("POST", "/api/workbooks", { name: "Presence" });
  const workbookId = ((await created.json()) as { workbook: WorkbookSummary }).workbook.id;
  for (const [member, role] of [
    [bob, "editor"],
    [vera, "viewer"],
  ] as const) {
    const response = await alice.request("POST", `/api/workbooks/${workbookId}/members`, {
      email: member.email,
      role,
    });
    expect(response.status).toBe(201);
  }
  const open = async (user: HttpUser) => {
    const client = connectCollab({ baseUrl: stack.baseUrl, workbookId, cookie: user.cookie });
    clients.push(client);
    expect((await client.outcome).kind).toBe("synced");
    return client;
  };
  return {
    alice,
    bob,
    vera,
    workbookId,
    a: await open(alice),
    b: await open(bob),
    v: await open(vera),
  };
}

const stateOf = (viewer: CollabClient, subject: CollabClient) =>
  viewer.provider.awareness?.getStates().get(subject.doc.clientID) as
    { user?: { id: string; email: string; color: string }; sheetId?: string } | undefined;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("presence identity (real server)", { timeout: 30_000 }, () => {
  it("drops an awareness state that claims another user's id, then relays the honest one", async () => {
    const { alice, bob, a, b } = await setup();

    b.provider.setAwarenessField("user", { id: alice.id, email: alice.email, color: "#f00" });
    // A control message that must arrive, proving the spoof had time to.
    a.provider.setAwarenessField("user", { id: alice.id, email: alice.email, color: "#00f" });
    await waitFor(() => stateOf(b, a)?.user?.id === alice.id);
    await pause(300);
    expect(stateOf(a, b)).toBeUndefined();
    // And nobody (including A) holds any state attributed to A except A's own.
    const attributedToAlice = [...(a.provider.awareness?.getStates() ?? [])].filter(
      ([, state]) => (state as { user?: { id: string } }).user?.id === alice.id,
    );
    expect(attributedToAlice.map(([clientId]) => clientId)).toEqual([a.doc.clientID]);

    // Honest state, with a forged email: arrives with the server's email.
    b.provider.setAwarenessField("user", {
      id: bob.id,
      email: "forged@example.com",
      color: "#0f0",
    });
    b.provider.setAwarenessField("sheetId", "s1");
    await waitFor(() => stateOf(a, b)?.user?.id === bob.id);
    expect(stateOf(a, b)?.user?.email).toBe(bob.email);
    expect(stateOf(a, b)?.sheetId).toBe("s1");
  });

  it("drops a state with no user at all, and can't remove another client's presence", async () => {
    const { alice, a, b } = await setup();
    a.provider.setAwarenessField("user", { id: alice.id, email: alice.email, color: "#00f" });
    await waitFor(() => stateOf(b, a)?.user?.id === alice.id);

    b.provider.setAwarenessField("sheetId", "no-user-field");
    await pause(300);
    expect(stateOf(a, b)).toBeUndefined();

    removeAwarenessStates(b.provider.awareness!, [a.doc.clientID], "test");
    await pause(300);
    const serverAwareness = stack.server.collab.documents.values().next().value?.awareness;
    expect(serverAwareness?.getStates().get(a.doc.clientID)).toBeDefined();
    expect(stateOf(a, a)?.user?.id).toBe(alice.id);
  });

  it("still relays a viewer's awareness", async () => {
    const { vera, a, v } = await setup();
    v.provider.setAwarenessField("user", { id: vera.id, email: vera.email, color: "#abc" });
    await waitFor(() => stateOf(a, v)?.user?.id === vera.id);
    expect(stateOf(a, v)?.user?.email).toBe(vera.email);
  });
});
