import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";

const lines: string[] = [];
const app = buildApp({ logStream: { write: (message) => void lines.push(message) } });

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("postgres pool errors", () => {
  it("an idle connection dropped by Postgres is logged, not thrown (it used to crash the server)", async () => {
    // What pg emits when the server terminates an idle client (e.g. `docker stop`, Neon suspend).
    const terminated = Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    );
    expect(() => pool.emit("error", terminated, {} as never)).not.toThrow();
    const record = lines
      .map((line) => JSON.parse(line) as { msg?: string; err?: { message?: string } })
      .find((r) => r.msg?.startsWith("postgres dropped an idle connection"));
    expect(record?.err?.message).toBe("terminating connection due to administrator command");

    // The pool still serves queries afterwards.
    const { rows } = await pool.query<{ ok: number }>("select 1 as ok");
    expect(rows[0]?.ok).toBe(1);
  });
});
