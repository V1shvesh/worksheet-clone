# Worksheet Clone — Project Context & Rationale

Companion to `CLAUDE.md`. This file explains **why**; `CLAUDE.md` says **what/how**.
Hand both files to the assistant at the start of every new session.

## 1. Goals

- Product: a usable multi-user spreadsheet others can sign up for and collaborate in.
- Learning: CRDT-based realtime systems, formula engines, grid virtualization, and disciplined AI-assisted development (plan → small commits → self-verifying tests).
- Constraints: personal budget, ability to "pause" the deployment with near-zero idle cost, everything in TypeScript, everything containerized.

## 2. Key decisions and trade-offs

### 2.1 CRDT: Yjs (decided)
Mature, fast binary encoding, `Y.UndoManager` gives per-user undo/redo out of the box (only undoes *your* changes, not collaborators'), awareness protocol for presence, and ready-made server (Hocuspocus). Automerge has a friendlier JSON model and full history, but heavier payloads and DIY undo.

### 2.2 Backend framework: Fastify + Hocuspocus

| Axis | Fastify + Hocuspocus | NestJS | Express |
|---|---|---|---|
| Boilerplate for a solo project | Low | High (modules, DI, decorators) | Low, but you assemble everything |
| TypeScript experience | Very good; schema-typed routes (zod type provider) | Very good | Weakest; types bolted on |
| Realtime/Yjs story | Hocuspocus is purpose-built: auth hook, persistence extension, debounced saves, read-only connections | Must wrap Hocuspocus or y-websocket in a gateway anyway | Same — wire it yourself |
| Testability | `fastify.inject()` tests routes without a network | Good testing module, more setup | supertest, fine |
| Performance | Fastest of the three | Runs on Express or Fastify underneath | Slowest |
| Structure at scale | You enforce it (we do: `domain/` is framework-free) | Enforced by the framework | You enforce it |
| Learning value | Learn the moving parts | Learn an opinionated framework | Familiar already |

**Decision:** Fastify + Hocuspocus. The hard part of this project is realtime, and Hocuspocus solves exactly that part; NestJS's structure mainly pays off on larger teams. If structure becomes a pain, the `domain/` layer keeps a later migration cheap.

### 2.3 Database: Postgres + Drizzle, hosted on Neon

Data is relational (users → workbooks → members/roles), and Yjs state is just bytes (`bytea`). Postgres covers both.

| Axis | Postgres + Drizzle | Postgres + Prisma | SQLite |
|---|---|---|---|
| Fit for users/workbooks/ACL | Excellent | Excellent | Good |
| Runtime weight / cold start | Light, no engine binary — matters when the container wakes from sleep | Heavier client; codegen step in builds | Lightest |
| Type safety | Schema in TS, SQL-like queries | Generated client, great DX | Via Drizzle too |
| Learning curve | Need to think in SQL (a plus for learning) | Gentlest | Gentle |
| Cloud deployment | Any managed Postgres | Any managed Postgres | Needs a persistent volume; single instance only; backups on you |
| Pause / idle cost | With Neon: compute scales to zero, you pay only storage | Same | Volume billed continuously |

**Decision:** Postgres + Drizzle. Prisma is a fine alternative if DX matters more than cold-start weight.

**Where Postgres runs:** Neon (free tier) rather than a Railway Postgres service, because:
- Neon compute suspends after 5 min idle and wakes in a few hundred ms → idle DB cost ≈ $0 on the free tier.
- A Railway Postgres container would be billed for RAM continuously, and a long-lived DB connection between Railway services keeps the app from sleeping.
- Neon branching gives free throwaway databases for preview deploys.
- Free-tier limits (0.5 GB storage, ~100 CU-hours/month at time of writing) are ample for a personal project; re-check before launch.

Local dev and CI use a plain `postgres` Docker container (compose / Testcontainers), so tests never depend on the network.

### 2.4 Hosting: Railway (decided) and how "pause" works

- One Railway service running one Docker image: Fastify serves the built SPA, `/api/*` REST and `/collab` WebSocket. One service means no private-network traffic, which would otherwise keep services awake.
- **Serverless (app sleeping) enabled:** Railway stops the container after ~10 min with no outbound traffic and restarts it on the next request. Caveat: open DB connections prevent sleep, so the `pg` pool uses `min: 0` and a short `idleTimeoutMillis`, and Hocuspocus flushes and closes nothing long-lived once the last client disconnects.
- Cost model: Hobby plan is a **$5/month minimum that includes $5 of usage**; a sleeping hobby app should stay inside it. It is a floor, not a ceiling — set a usage limit in Railway.
- **Hard pause:** remove the active deployment (or hit the spend limit); data lives in Neon and is unaffected. **Resume:** redeploy. No data migration needed.
- Trade-off accepted: first request after sleep pays a cold start (container + Neon wake). A "waking up…" state in the UI hides it.

### 2.5 Formula engine: HyperFormula
Runs **client-side** on each user's machine, fed from the Y.Doc. The CRDT stores only inputs; every client deterministically recomputes the same results. This answers "one edit affects many dependent cells": only the edited cell syncs, dependents recompute locally — no fan-out of writes, no conflicts on derived values.
- **License note:** HyperFormula is GPLv3 or commercial. Using `licenseKey: 'gpl-v3'` means the project should be GPLv3-compatible if distributed. Fine for an open-source personal project — decide the repo license with this in mind.
- Optional later: a server-side HyperFormula instance for validation or exports.

### 2.6 Grid: AG Grid Community behind a port (see `docs/adr/0001-grid-abstraction.md`)
- Range selection, fill handle and clipboard ranges are AG Grid Enterprise features ($999/dev). Alternatives considered: AG Grid Enterprise, Glide Data Grid, RevoGrid, Handsontable.
- **Decision:** AG Grid Community, used only to paint virtualized cells/headers and capture gestures. We build selection, keyboard, fill handle, clipboard, editor and menus ourselves in grid-agnostic TypeScript, talking to the grid through one `GridView` interface.
- **Why this avoids lock-in:** the spreadsheet *behavior* is ours, so it survives a grid swap. Swapping = one new adapter that passes the port contract test suite. ESLint stops `ag-grid-*` imports leaking outside the adapter; e2e tests use our own `data-*` attributes, not AG Grid's DOM.
- **Cost accepted:** more code in M4/M6, and overlays (selection rectangles, fill handle, floating editor) must stay aligned with the grid while scrolling. That alignment is the main risk to watch; the fallback is a new adapter (Enterprise or another grid) without touching anything above the port.

### 2.7 State management split
- **Yjs** = shared document (cells, formats, sheet list, row/col order, workbook name).
- **Redux Toolkit** = local UI state (selection, active sheet id, edit mode, formula-bar draft, dialogs, connection/sync status, errors). Selection is stored as row/col **ids** (so it survives a collaborator inserting rows) and converted to visual indices for the grid port.
- **RTK Query** = REST data (session, workbook list, members).
- Components read doc data through small hooks (`useCell(sheetId, rowId, colId)`) built on `useSyncExternalStore` over Yjs observers, so the grid re-renders only changed cells.

### 2.8 Auth
Self-built email/password with argon2id and server-side sessions in Postgres (httpOnly, Secure, SameSite=Lax cookie). Small surface, no third-party dependency, good learning. The WebSocket handshake carries the same cookie; Hocuspocus `onAuthenticate` resolves the session and the user's role on that workbook.
Alternative if this becomes a chore: Neon Auth / an OAuth provider later.

## 3. Architecture mental model

```
Browser                                         Railway container                     Neon
┌──────────────────────────────┐   REST /api   ┌──────────────────────────┐   SQL    ┌──────────┐
│ React + Redux (UI state)     │ ────────────▶ │ Fastify routes           │ ───────▶ │ users     │
│ RTK Query (workbooks, auth)  │               │  auth, workbooks, members│          │ sessions  │
│                              │               │ domain/ (ACL, services)  │          │ workbooks │
│ Y.Doc  ◀── HocuspocusProvider│ ◀═ WS /collab═▶│ Hocuspocus               │ ───────▶ │ members   │
│   │  y-indexeddb (offline)   │               │  onAuthenticate (role)   │          │ yjs_docs  │
│   ▼                          │               │  Database ext (bytea)    │          │ (bytea)   │
│ HyperFormula (computed vals) │               └──────────────────────────┘          └──────────┘
│   ▼                          │
│ SheetViewModel → GridView    │
│   (AG Grid adapter) + overlay│
└──────────────────────────────┘
```

### 3.1 Y.Doc schema (one doc per workbook)

```
doc.getMap('meta')          → { name: string, schemaVersion: number }
doc.getArray('sheetOrder')  → sheetId[]
doc.getMap('sheets')        → sheetId → Y.Map {
    name: string, hidden: boolean,
    rowOrder: Y.Array<rowId>, colOrder: Y.Array<colId>,
    cells:   Y.Map<"rowId:colId", { v?: string|number|boolean, f?: string /* id-ref formula */ }>,
    formats: Y.Map<"rowId:colId", { bg?: string, b?: true, i?: true, u?: true }>,
    colWidths / rowHeights: Y.Map<id, number>
}
```

**Why stable row/col ids:** with positional keys (`A1`), a user inserting a row while another edits `A5` would make the edit land in the wrong cell after merge. With ids, structure ops (insert/delete/reorder) only touch `rowOrder`/`colOrder`, and cell edits merge cleanly.

**Why id-based formula refs:** `=A1+B2` stored as text breaks under concurrent structure changes. Formulas are stored as e.g. `=[[r:k3f,c:9az]]+[[r:p02,c:x1m]]` and translated to A1 for the formula bar and for HyperFormula. A deleted referent becomes `#REF!`, as in Excel.

**Yjs has no native move:** reorder = delete + insert in one transaction. Concurrent moves of the same row can duplicate the id; the client de-duplicates when reading `rowOrder` (first occurrence wins, deterministically on all clients).

### 3.2 Edit lifecycle (requirement 6)
1. User action (type in a cell, paste a range, delete a column) → one `doc.transact(..., LOCAL_ORIGIN)`.
2. Yjs applies locally (optimistic); the observer updates HyperFormula → dependent cells re-render.
3. The provider sends one update message per transaction → the action is atomic on the wire.
4. Hocuspocus applies it, broadcasts to other clients, debounces persistence to Postgres.
5. `Y.UndoManager` (trackedOrigins = LOCAL_ORIGIN, captureTimeout ≈ 500 ms) groups the same transaction for undo/redo.

### 3.3 Rollback & error handling strategy
CRDT updates cannot be "rejected" after the fact without forking state, so we prevent bad writes and recover cleanly:
- **Prevent:** viewers get `connection.readOnly = true` (server drops their updates); the UI disables editing for viewers. Client-side validation before transact (formula parse errors become a cell value, not a failed write).
- **User rollback:** undo/redo via UndoManager — inverse operations, so it is collaboration-safe.
- **Server rejection** (access revoked, doc too large, schema violation detected in `onChange`): server closes the connection with a typed close code → client shows a banner, stops editing, discards the local doc and reloads the authoritative state (pending local changes are exported to a recovery copy, not silently lost).
- **Network loss:** y-indexeddb keeps edits locally; the provider reconnects with backoff; status indicator (Saved / Saving / Offline / Reconnecting). Yjs merges on reconnect.
- **Persistence failure on the server:** retry with backoff; the in-memory doc stays authoritative; alert via logs; clients are not told "saved" until the server acks (Hocuspocus `synced`/unsynced-changes state).
- **Formula engine errors:** never crash the grid; show `#ERROR!`-style values and log.

### 3.4 Concurrency (requirement 7)
Conflict resolution comes from Yjs: last-writer-wins per cell key (deterministic across clients), structural ops merge as described above. Presence (who is in which cell) via awareness in M8. **Version history** (snapshots from the stored update log, restore points) is future scope; the persistence layer stores periodic snapshots from the start so it can be added without migration pain.

### 3.5 ACL (minimal)
`workbook_members(workbook_id, user_id, role: 'owner'|'editor'|'viewer')`. Owner: delete workbook, manage members, rename. Editor: edit content, sheets. Viewer: read-only. Enforced in `domain/acl.ts`, used by both REST handlers and Hocuspocus `onAuthenticate`. Members are added by email of an existing account (no email invites in v1).

## 4. Testing strategy

| Layer | Tool | What |
|---|---|---|
| shared | Vitest | formula id-ref codec, doc accessors, zod schemas — property tests for codec round-trips |
| server functional | Vitest + `fastify.inject` + Testcontainers Postgres | routes, ACL matrix, session handling, migrations |
| server e2e | Vitest + real server on a random port + Testcontainers + two `HocuspocusProvider` clients in Node | signup → create workbook → two users edit → convergence; viewer writes dropped; revoked access closes socket; persistence survives restart |
| web functional | Vitest + Testing Library + jsdom | components, hooks, reducers, HyperFormula adapter, undo grouping; grid interaction against the `fake` adapter |
| grid port contract | Vitest (fake adapter) + Playwright component tests (AG Grid adapter) | the same suite run against every adapter: geometry, hit-testing, refresh, event mapping |
| web hermetic e2e | Playwright | real built SPA, **no real backend**: REST mocked with `page.route`, collaboration WebSocket mocked with `page.routeWebSocket` driving an in-test Yjs doc (so we can simulate a "remote user" and server errors deterministically) |
| optional full-stack smoke | Playwright against `docker compose` | a couple of happy-path flows, run in CI nightly, not per commit |

Gate summary is in `CLAUDE.md`. Running every e2e suite in a pre-commit hook would make commits take minutes, so the local hook runs the fast checks and CI runs everything on every pushed commit — main only accepts green commits.

## 5. Environment notes / quirks

- Planning happened in a Claude chat; development continues locally in Claude Code on macOS (Apple Silicon).
- Prerequisites: Node 24 LTS (pin in `.nvmrc` and `engines`), pnpm via Corepack, Docker Desktop (needed for compose and Testcontainers), Git, GitHub CLI.
- Apple Silicon vs Railway: dev images are arm64, Railway runs amd64. Let Railway or CI build the production image from the Dockerfile; when building locally for deploy, pass `--platform linux/amd64`.
- `argon2` is a native module: install dependencies inside the Docker build stage. Never copy a host `node_modules` into the image (add it to `.dockerignore`).
- Railway: set a spend limit; enable Serverless on the service; health check on `/api/health` must not touch the DB (or it keeps Neon awake).
- Neon: use the **pooled** connection string in prod; regular TCP `pg` driver (not the HTTP driver) because we need transactions.
- Choose Neon and Railway regions close to each other.

## 6. Learning goals

- Understand Yjs internals well enough to debug merge behavior (state vectors, transactions, origins).
- Build a virtualized grid with a custom selection model.
- Practice plan-first, small-commit, test-first AI-assisted development; keep a failure log (`docs/failure-log.md`).

## 7. Open decisions (ask before deciding)

| Decision | Notes | Needed by |
|---|---|---|
| Repo license | HyperFormula's free key is GPLv3, so the project should be GPLv3-compatible (GPLv3 or AGPLv3) unless a commercial HyperFormula license is bought | M0 (`LICENSE` file), before going public at the latest |
| GitHub repo name and visibility | Public suits GPL and a portfolio; private is fine until launch | M0 |
| Hosting regions | Developer is in Delhi. Pick Neon and Railway regions close to each other and to users (Singapore is the likely nearest pair; confirm what both offer) | M0, when the Neon project and Railway service are created |
| Custom domain | Optional; Railway's default domain works | M9 |
| Grid adapter | AG Grid Community for now (ADR-0001); revisit only if overlay alignment or performance becomes a real problem | After M4b/M6 |

## 8. Status narrative

- 2026-10-04: Stack decided (Yjs, Fastify + Hocuspocus, Postgres + Drizzle on Neon, Railway). Planning docs written. Next: M0 walking skeleton.
- 2026-10-04: Stayed on AG Grid Community (Enterprise too costly for a personal project); grid isolated behind a `GridView` port, recorded in ADR-0001.
- 2026-10-04: Planning docs placed in `~/projects/worksheet-clone` (no git repo or code yet). Work moves to Claude Code. Next: propose the M0 plan, then build it.
