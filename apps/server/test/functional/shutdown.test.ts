import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getSheetName, readSheetOrder, setSheetName } from "@worksheet-clone/shared";
import { connectCollab, waitFor } from "../helpers/collab.js";
import { createScratchDatabase } from "../helpers/scratch-db.js";

// Boots the real entry point (migrations, listen, signal handlers) as a child
// process on a scratch database, because the signal wiring only exists there.
const serverDir = fileURLToPath(new URL("../..", import.meta.url));

describe("graceful shutdown (real process)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
  });
  afterAll(async () => {
    child?.kill("SIGKILL");
    await scratch.drop();
  });

  it("flushes an open workbook, closes sockets and the pool, and exits 0 on SIGTERM", async () => {
    child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: serverDir,
      env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: scratch.url, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child?.on("exit", (code, signal) => resolve({ code, signal })),
    );
    let output = "";
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
      child?.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/Server listening at http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      child?.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    });

    async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    }
    const signup = await post("/api/auth/signup", {
      email: `shutdown-${crypto.randomUUID()}@example.com`,
      password: "correct-password",
    });
    expect(signup.status).toBe(201);
    const cookie = `session=${signup.headers.get("set-cookie")?.match(/^session=([^;]+)/)?.[1]}`;
    const created = await post("/api/workbooks", { name: "Shutdown" }, cookie);
    const workbookId = ((await created.json()) as { workbook: { id: string } }).workbook.id;

    const client = connectCollab({ baseUrl, workbookId, cookie });
    expect((await client.outcome).kind).toBe("synced");
    const [sheetId = ""] = readSheetOrder(client.doc);
    setSheetName(client.doc, sheetId, "Flushed on SIGTERM");
    await waitFor(() => !client.provider.hasUnsyncedChanges);

    // The client stays connected: the server has to close the socket itself
    // and store the document on the way out, well before the 2s debounce.
    child.kill("SIGTERM");
    const result = await exited;
    expect(result).toEqual({ code: 0, signal: null });
    expect((await client.closed).code).toBeGreaterThan(0);
    client.destroy();

    const db = new Client({ connectionString: scratch.url });
    await db.connect();
    try {
      const { rows } = await db.query<{ state: Buffer }>(
        "select state from yjs_documents where workbook_id = $1",
        [workbookId],
      );
      expect(rows).toHaveLength(1);
      const stored = new Y.Doc();
      Y.applyUpdate(stored, new Uint8Array(rows[0]?.state ?? []));
      expect(getSheetName(stored, sheetId)).toBe("Flushed on SIGTERM");
    } finally {
      await db.end();
    }
    expect(output).toContain("SIGTERM received");
  }, 60_000);
});
