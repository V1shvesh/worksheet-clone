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

## Rate limits

Defaults live in `src/http/rate-limits.ts` (`DEFAULT_RATE_LIMITS`); `buildApp({ rateLimits })` overrides them (under `NODE_ENV=test` an unconfigured app gets relaxed values so suites that sign up dozens of users do not trip them; login keeps its real limit). Counters are in memory, per process.

| What                                 | Limit                              | Keyed by       | Mechanism                            |
| ------------------------------------ | ---------------------------------- | -------------- | ------------------------------------ |
| `/api` in general (health is exempt) | 300 / minute                       | IP             | `@fastify/rate-limit`                |
| `POST /api/auth/signup`              | 5 / hour                           | IP             | `@fastify/rate-limit` (route config) |
| `POST /api/auth/login`               | 5 / minute                         | IP             | `@fastify/rate-limit` (route config) |
| `POST /api/workbooks`                | 30 / minute                        | signed-in user | token bucket, after `requireUser`    |
| `POST /api/workbooks/:id/members`    | 30 / minute                        | signed-in user | token bucket, after `requireUser`    |
| `/collab` upgrade attempts           | burst of 60, refilling 60 / minute | IP             | token bucket in the upgrade handler  |

Every refusal is `429` with `{ error: { code: "RATE_LIMITED", message } }` and a `Retry-After` header (WebSocket upgrades get a bare `HTTP/1.1 429` with `Retry-After`). Signup and login have their own counters and are not counted against the 300/minute one.

The IP comes from the socket unless `TRUST_PROXY` is set. Behind Railway set `TRUST_PROXY=1` (one proxy in front: the client is the last `X-Forwarded-For` entry) and check in the logs that `req.remoteAddress` shows real client addresses; a larger number means more proxies, `true` believes the leftmost (forgeable) entry. Without it every request would share the proxy's address and a single user could exhaust everybody's budget; with it set wrongly (too many hops) the limits can be bypassed by spoofing the header.

## Session cleanup

Expired sessions are deleted once at start-up and then hourly (`src/session-cleanup.ts`). The timer is unref'd and cleared on close, so it never keeps the process alive; a sleeping Railway container does not run it, and a run while awake is one cheap `delete ... where expires_at < now()` that lets Neon go back to sleep after its usual 5 idle minutes.

## Dependency audit (`pnpm audit --prod`, 2026-11-09)

Fixed: `@fastify/static` 8 to 10.1.10 (path traversal and route-guard bypass, high), `fastify` to 5.12.8, and via `overrides` in `pnpm-workspace.yaml` the patched `fast-uri` (3.1.9 / 4.2.3) and `ip-address` (10.7.4) that Fastify's and rate-limit's own ranges had not picked up. Remove an override once `pnpm why <pkg>` shows a patched version without it.

Left, with reasons:

- `zod` (high, "memory exhaustion validating oversized constrained collections", fixed only in zod 4): no schema in `packages/shared` constrains an array, set or record, request bodies are capped at 64 KB, and moving shared and web from zod 3 to 4 is a separate migration.
- `react-router` 6 (two moderate, open redirect via backslash in `<Link>` and SSR hydration `deserializeErrors`): the web app is client-rendered with no SSR; the fix is React Router 7, a web migration outside the server track. The open-redirect advisory applies if a link target comes from user input, so review any `navigate(userValue)` before launch.
- `minimatch` (moderate): only reachable through `typescript-eslint` in `packages/config` (lint time), not shipped.

Dev-only findings from the full `pnpm audit` (vitest 2 / vite 6 / esbuild / tinypool / undici in test tooling) affect developer machines running the dev server or test UI, not production; upgrading vitest 2 to 4 is a separate task.

## Local prod-like stack and smoke test

`pnpm docker:up` builds the image and starts it with its own Postgres (`docker/docker-compose.prod.yml`, project `worksheet-prod`) on http://localhost:8080; `pnpm docker:down` stops it (the data volume stays). The development database in `docker/docker-compose.yml` is separate. `pnpm test:smoke` runs `apps/web/e2e/smoke` against it (set `SMOKE_BASE_URL` for another host). Production-mode rate limits apply: signup is 5 per hour per IP and counted in memory, and a run uses 2 signups, so after two runs in an hour do `docker compose -f docker/docker-compose.prod.yml restart app`.

Checked by hand on 2026-11-09: restarting the app container keeps the data and the second start logs `database is up to date` (`applied: []`); `docker compose stop app` logs `SIGTERM received: shutting down`, unloads every open workbook (stored to Postgres), exits 0 in about 0.3 s, and an edit made just before the stop was readable by a fresh browser afterwards.

## Backups and restore

- **Neon (production).** Point-in-time restore is built in (free tier: a short history window, check the current length in the console). To restore: Neon console -> Branches -> Restore (or create a branch at a past time), then point `DATABASE_URL` / `DATABASE_URL_UNPOOLED` at the restored branch, or copy data back. Do this for accidents; do not rely on it as the only copy.
- **Your own dumps.** `pnpm db:dump` writes `backups/worksheet-<timestamp>.dump` (custom format, gitignored). With no `DATABASE_URL` it dumps the local prod-like stack; with `DATABASE_URL=<neon unpooled url>?sslmode=verify-full pnpm db:dump` it dumps that database (pg_dump runs in a `postgres:17-alpine` container, so no local client is needed). Do this before risky migrations and on a schedule you will actually keep.
- **Restore.** `pnpm db:restore backups/<file>.dump [name]` restores into a FRESH database (default `worksheet_restore`, dropped and recreated) on the local prod-like stack, so a restore can be inspected before anything is switched over. `RESTORE_DATABASE_URL=<url> pnpm db:restore <file>` restores into an existing database instead (with `--clean --if-exists`: it drops what it replaces, so aim it at a new Neon branch, never at production by reflex).

Rehearsed 2026-11-09 against the local stack (a workbook with `5`, `10`, `=SUM(A1:A2)`, `from bob` created by the smoke test):

```bash
pnpm docker:up
pnpm test:smoke
pnpm db:dump                       # backups/worksheet-20261109-145859.dump (20270 bytes)
pnpm db:restore backups/worksheet-20261109-145859.dump
# compare live and restored databases
docker compose -f docker/docker-compose.prod.yml exec -T db psql -U worksheet -d worksheet_restore -tAc \
  "select (select count(*) from users),(select count(*) from workbooks),(select count(*) from yjs_documents),
   (select md5(string_agg(md5(state),',' order by workbook_id)) from yjs_documents)"
```

Result: identical counts (5 users, 3 workbooks, 2 documents, 2 migrations) and an identical md5 over every document state in `worksheet` and `worksheet_restore`. The restored Y.Doc was also decoded with `yjs`: cells `5`, `10`, the `=SUM` formula (id-based refs) and `from bob` were all present.

## Pause and resume

- **Idle disconnect (client side).** A tab left open would keep its WebSocket, and so the container, alive. The client therefore calls `provider.disconnect()` after 5 minutes hidden (`IDLE_HIDDEN_MS`) or 30 minutes without pointer/keyboard/wheel/touch input while visible (`IDLE_INPUT_MS`), and `provider.connect()` when the user returns (tab visible, input, or `online`). Unconfirmed changes delay it until confirmed, or `IDLE_UNSYNCED_GRACE_MS` (2 minutes) at most; it never fires during an access-loss state or while the provider is already reconnecting. Constants live in `apps/web/src/crdt/idle.ts`. Edits made while paused are kept in IndexedDB and sync on reconnect. Cost advice (usage limit, Serverless, no pingers, one service) is in `docs/deploy.md`, "Keeping costs low".

- **Idle (automatic).** With Serverless on, Railway stops the container after ~10 minutes without outbound traffic and Neon suspends its compute after 5 idle minutes; both wake on the next request. Cost while asleep is about nothing.
- **Hard pause.** Railway: service -> Deployments -> remove the active deployment (the service stays configured; or let the usage limit stop it). The site is down; all data stays in Neon. Neon can stay as is (free tier) or be suspended.
- **Resume.** Redeploy the latest deployment in Railway (or push a commit). Migrations run on start; there is nothing to migrate back. Run the first three items of the first-deploy checklist in `docs/deploy.md`.
