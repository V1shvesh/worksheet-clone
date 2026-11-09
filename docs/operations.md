# Operations

How the server behaves in production. Rationale for hosting choices lives in `PROJECT_CONTEXT.md` §2.3–2.4.

## Environment variables

Validated once at start-up by `apps/server/src/config.ts`. A bad environment exits with code 1 and a message listing every problem. Blank values count as unset.

| Variable                | Required in production               | Notes                                                                                                                                                                             |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`              | set to `production` (the image does) | Switches on required secrets, `Secure` cookies, HSTS and SPA serving. Default `development`.                                                                                      |
| `PORT`                  | no                                   | Default 3000.                                                                                                                                                                     |
| `DATABASE_URL`          | yes                                  | The **pooled** Neon URL, with `?sslmode=verify-full` (or `require`, which `pg` currently treats the same and warns about). Dev/test default to the local docker-compose Postgres. |
| `DATABASE_URL_UNPOOLED` | no                                   | Direct Neon URL used for migrations and their advisory lock (session locks do not survive a transaction-mode pooler). Falls back to `DATABASE_URL`.                               |
| `COOKIE_SECRET`         | yes, at least 32 characters          | Signs the session cookie. There is no fallback in production; rotating it signs everybody out.                                                                                    |
| `WEB_DIST_DIR`          | no                                   | Where the built SPA is. The Docker image sets it.                                                                                                                                 |
| `TRUST_PROXY`           | set on Railway                       | `true`, `false`, or a positive integer (number of proxy hops). Only then is `X-Forwarded-For` believed for `request.ip` (rate limits). Leave unset when not behind a proxy.       |

## Migrations

The server applies pending migrations itself before it starts listening (`runMigrations` in `src/db/migrate.ts`), on a dedicated connection holding a Postgres advisory lock. Two instances starting together do not migrate concurrently: the second waits, then finds nothing to do. A failed migration exits non-zero, so the deploy does not go live. `pnpm db:migrate` (or `node dist/db/migrate-cli.js`) runs the same code by hand.

The compiled output carries its own copy of the migrations folder (`pnpm build` copies `src/db/migrations` to `dist/db/migrations`).

**Migrations must be additive (expand/contract).** During a deploy the previous version keeps serving while the new one migrates, and a rollback runs old code against the new schema. So:

- Add tables, columns (nullable or with a default) and indexes in one release; stop using something in a later release; only then drop it in a third.
- Never rename or drop a column/table, or add a `NOT NULL` column without a default, in the same release that stops using it.
- Never rewrite large tables in a migration (it runs while the app is down to new traffic).
