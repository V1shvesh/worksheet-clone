import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { BuildAppOptions } from "../../src/app.js";

export interface Stack {
  readonly baseUrl: string;
  readonly server: FastifyInstance;
  /** The app's own pool, for tests that break or inspect the database. */
  readonly pool: Pool;
  /** Stops the server (flushing open docs) and starts a fresh one on the same database. */
  restartServer: () => Promise<void>;
  stop: () => Promise<void>;
}

// Real server on a random port + a throwaway Postgres. db/client reads
// DATABASE_URL at import time, so everything that touches it is imported
// dynamically after the env var is set.
export async function startStack(appOptions: BuildAppOptions = {}): Promise<Stack> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("worksheet")
    .withUsername("worksheet")
    .withPassword("worksheet")
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();

  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const client = await import("../../src/db/client.js");
  const pool: Pool = client.pool;
  await migrate(client.db, { migrationsFolder: "./src/db/migrations" });

  const { buildApp } = await import("../../src/app.js");
  async function listen(): Promise<{ server: FastifyInstance; baseUrl: string }> {
    const server = buildApp(appOptions);
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, baseUrl: `http://127.0.0.1:${port}` };
  }

  let current = await listen();
  return {
    get baseUrl() {
      return current.baseUrl;
    },
    pool,
    get server() {
      return current.server;
    },
    restartServer: async () => {
      await current.server.close();
      current = await listen();
    },
    stop: async () => {
      await current.server.close();
      await pool.end();
      await container.stop();
    },
  };
}

export class HttpUser {
  cookie = "";

  // Takes the stack (not a URL) so requests follow a server restart.
  constructor(
    private readonly stack: { readonly baseUrl: string },
    readonly email: string,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.stack.baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const match = response.headers.get("set-cookie")?.match(/^session=([^;]+)/);
    if (match?.[1]) {
      this.cookie = `session=${match[1]}`;
    }
    return response;
  }

  async signup(): Promise<void> {
    const response = await this.request("POST", "/api/auth/signup", {
      email: this.email,
      password: "correct-password",
    });
    if (response.status !== 201) {
      throw new Error(`signup failed: ${response.status}`);
    }
  }
}
