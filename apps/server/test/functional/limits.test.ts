import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import * as Y from "yjs";
import { LIMITS } from "@worksheet-clone/shared";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { loadDocumentState, storeDocumentState } from "../../src/domain/documents.js";
import { createWorkbook } from "../../src/domain/workbooks.js";
import { extractDocUpdate } from "../../src/realtime/doc-size-limit.js";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient, type TestClient } from "../helpers/http.js";

const DOC_CAP = 200_000;
const emails = testEmails("test-limits");
const logs: string[] = [];
let app: FastifyInstance;
let baseUrl: string;
const clients: CollabClient[] = [];

beforeAll(async () => {
  app = buildApp({
    limits: { docBytes: DOC_CAP, wsMessageBytes: 1_000_000, restBodyBytes: 2_048 },
    logStream: { write: (line) => void logs.push(line) },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  await waitFor(() => app.collab.getDocumentsCount() === 0);
  await cleanupByEmailPattern(emails.pattern);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function connect(user: TestClient, workbookId: string): Promise<CollabClient> {
  const client = connectCollab({ baseUrl, workbookId, cookie: `session=${user.cookies.session}` });
  clients.push(client);
  expect((await client.outcome).kind).toBe("synced");
  return client;
}

const blob = (client: CollabClient, key: string, size: number) =>
  client.doc.getMap<string>("scratch").set(key, "x".repeat(size));

describe("REST body limit", () => {
  it("refuses a body over the limit with 413 and our error shape", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@example.com", password: "x".repeat(3_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
    });
  });

  it("accepts a body under the limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@example.com", password: "x".repeat(1_000) },
    });
    expect(response.statusCode).not.toBe(413);
  });

  it("ships the documented defaults", () => {
    expect(LIMITS).toEqual({
      restBodyBytes: 65_536,
      wsMessageBytes: 2_097_152,
      docBytes: 10_485_760,
      cellChars: 32_767,
    });
  });
});

describe("WebSocket message limit", () => {
  it("closes a socket that sends a message over the limit with 1009", async () => {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/collab`, {
      headers: { origin: baseUrl },
    });
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    socket.send(new Uint8Array(1_100_000));
    expect(await closed).toBe(1009);
  });
});

describe("workbook size cap", () => {
  async function setup() {
    const owner = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Capped");
    return { owner, workbook };
  }

  it("applies updates that fit", async () => {
    const { owner, workbook } = await setup();
    const a = await connect(owner, workbook.id);
    const b = await connect(owner, workbook.id);
    blob(a, "small", 50_000);
    await waitFor(() => b.doc.getMap("scratch").get("small") !== undefined);
  });

  it("refuses one huge update: sender closed with 4413, nothing applied, broadcast or stored", async () => {
    const { owner, workbook } = await setup();
    const sender = await connect(owner, workbook.id);
    const watcher = await connect(owner, workbook.id);
    blob(sender, "huge", DOC_CAP * 2);

    expect((await sender.closed).code).toBe(4413);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watcher.doc.getMap("scratch").get("huge")).toBeUndefined();
    expect(app.collab.documents.get(workbook.id)?.getMap("scratch").get("huge")).toBeUndefined();

    sender.destroy();
    watcher.destroy();
    clients.length = 0;
    await waitFor(() => app.collab.getDocumentsCount() === 0);
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await loadDocumentState(workbook.id)) ?? new Uint8Array());
    expect(stored.getMap("scratch").get("huge")).toBeUndefined();
    expect(logs.join("")).toContain(
      "refused an update that would push a workbook past its size cap",
    );
  });

  it("refuses the update that crosses the cap after several that fit, and keeps the rest", async () => {
    const { owner, workbook } = await setup();
    const client = await connect(owner, workbook.id);
    const other = await connect(owner, workbook.id);
    for (const key of ["a", "b", "c"]) {
      blob(client, key, 40_000);
      await waitFor(() => other.doc.getMap("scratch").get(key) !== undefined);
    }
    blob(client, "d", 80_000);
    expect((await client.closed).code).toBe(4413);
    expect(other.doc.getMap("scratch").get("d")).toBeUndefined();
    expect(other.doc.getMap("scratch").get("c")).toBeDefined();
    // Collaborators are unaffected: the other client keeps working.
    blob(other, "e", 1_000);
    await waitFor(
      () => app.collab.documents.get(workbook.id)?.getMap("scratch").get("e") !== undefined,
    );
  });

  it("lets a workbook already over the cap shrink, but not grow", async () => {
    const { owner, workbook } = await setup();
    const seed = new Y.Doc();
    seed.getMap("scratch").set("legacy", "x".repeat(DOC_CAP + 100_000));
    await storeDocumentState(workbook.id, Y.encodeStateAsUpdate(seed));

    const client = await connect(owner, workbook.id);
    expect(client.doc.getMap("scratch").get("legacy")).toBeDefined();
    client.doc.getMap("scratch").delete("legacy");
    await waitFor(
      () => app.collab.documents.get(workbook.id)?.getMap("scratch").get("legacy") === undefined,
    );
    // Back under the cap: growth that fits is allowed again.
    blob(client, "after", 10_000);
    await waitFor(
      () => app.collab.documents.get(workbook.id)?.getMap("scratch").get("after") !== undefined,
    );
  });
});

describe("extractDocUpdate", () => {
  it("returns null for frames that cannot change the document", () => {
    expect(extractDocUpdate(new Uint8Array())).toBeNull();
    expect(extractDocUpdate(new Uint8Array([1, 0x61, 1]))).toBeNull(); // awareness
    expect(extractDocUpdate(new Uint8Array([1, 0x61, 0, 0, 0]))).toBeNull(); // sync step 1
  });

  it("returns the update bytes of a sync update", () => {
    const frame = new Uint8Array([1, 0x61, 0, 2, 3, 7, 8, 9]);
    expect([...(extractDocUpdate(frame) ?? [])]).toEqual([7, 8, 9]);
  });
});
