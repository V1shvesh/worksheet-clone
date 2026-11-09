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

## Shutdown

On `SIGTERM`/`SIGINT` (Railway sends SIGTERM on every deploy and when the service sleeps) the server stops accepting connections, closes the WebSockets, waits (bounded to 5 s) for open workbooks to be stored, closes the database pool and exits 0. A second signal, or a drain that takes longer than 20 s, exits 1 immediately. Any workbook the database kept refusing is logged at error level ("shutting down with UNSAVED changes").

## Security headers

`@fastify/helmet` runs on every response (SPA, API, errors). The Content-Security-Policy (`src/http/security-headers.ts`):

```
default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';
object-src 'none'; base-uri 'self'; form-action 'self'
```

`'unsafe-inline'` for styles and `data:` for fonts/images exist because AG Grid injects styles and inlines its icon font in CSS. Scripts allow no inline code or `eval`. `connect-src 'self'` also covers the `/collab` WebSocket (CSP Level 3: `'self'` matches `ws:`/`wss:` on the same host). That was checked in Chromium against the production build (signup, open a workbook, edit, reload: no CSP violations, the socket connects); Firefox and Safari were not run here, so if a browser blocks the socket after a deploy, add `wss://<public host>` to `connect-src`. HSTS (6 months, includeSubDomains, no preload) is sent only when `NODE_ENV=production`.

## Size limits

Defined once in `packages/shared/src/limits.ts` (`LIMITS`) so the client can check before sending.

| Limit                                | Value  | Enforced in                                              | What happens                                             |
| ------------------------------------ | ------ | -------------------------------------------------------- | -------------------------------------------------------- |
| REST body (`restBodyBytes`)          | 64 KB  | Fastify `bodyLimit`                                      | `413 { error: { code: "PAYLOAD_TOO_LARGE" } }`           |
| WebSocket message (`wsMessageBytes`) | 2 MB   | `ws` `maxPayload` (via crossws `serverOptions`)          | socket closed with 1009                                  |
| Workbook document (`docBytes`)       | 10 MB  | `realtime/doc-size-limit.ts`, `beforeHandleMessage`      | see below                                                |
| Cell text (`cellChars`)              | 32 767 | not enforced on the server (cells live inside the Y.Doc) | exported for the client to enforce when a cell is edited |

**When a document would exceed its cap.** The check runs before Hocuspocus applies an incoming update. If the running size estimate says it might not fit, the server measures the real document, applies the update to a throwaway copy and measures that. An update is refused only if the result is over the cap _and_ larger than the current document (so a workbook at or over the cap can always shrink). A refused update is never applied, never broadcast to collaborators and never stored. The sender's socket is closed with code 4413 and reason `too-large`; collaborators are unaffected. A CRDT cannot take an update back once applied, which is why the check is before and not after.

Limits of that: the sender's browser still holds its oversized change (in memory and in its on-device cache), and a provider that reconnects re-sends it and is refused again, so the client must stop reconnecting on 4413 and tell the user. Documents already over the cap when the rule shipped keep working and can only shrink. The size estimate may overcount (it sums update sizes) and then costs one extra measurement; measuring is O(document) and only happens for workbooks within one update of the cap.
