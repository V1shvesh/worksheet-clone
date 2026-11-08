# Worksheet Clone — Build Plan

Each milestone ends **deployed and green in CI**. Each bullet is roughly one commit (or a small PR).
Plan-first rule: before starting a milestone, ask the assistant for a detailed plan of that milestone only, review it, then build.

---

## M0 — Walking skeleton

Goal: an empty app that is linted, tested, containerized and live on Railway.

- `git init` (first commit = these planning docs), `.gitignore`, `.dockerignore`, `.editorconfig`, `.nvmrc`, `LICENSE` (see open decisions), README stub
- pnpm workspace, Turborepo, `packages/config` (tsconfig base, eslint, prettier)
- `apps/server`: Fastify with `/api/health`; serves static files from `apps/web/dist` in prod
- `apps/web`: Vite + React + Redux Toolkit store, router, placeholder page
- `packages/shared`: zod, a first shared type
- Vitest in every package with one real test; Playwright with one hermetic spec
- Husky + lint-staged pre-commit / pre-push; GitHub Actions CI (all gates + docker build)
- Multi-stage Dockerfile (deps → build → slim runtime, non-root user); `docker-compose.yml` (app + postgres)
- Railway service from GitHub, Serverless on, spend limit; Neon project created (unused yet)
  **Done when:** a commit to main deploys automatically and `/api/health` returns OK on the public URL.

## M1 — Authentication

- Drizzle setup + migrations: `users`, `sessions`; migrate on container start
- `POST /api/auth/signup | login | logout`, `GET /api/auth/me`; argon2id; rate limit on login
- Session cookie plugin; `requireUser` preHandler
- Web: sign up / log in pages, RTK Query auth API, route guards, error states
- Tests: functional (validation, duplicate email, wrong password, expired session); server e2e signup→me; Playwright: signup/login flows with mocked API
  **Done when:** a real user can sign up on the deployed app and stay logged in across reloads.

## M2 — Workbooks + minimal ACL

- Tables: `workbooks`, `workbook_members`, `yjs_documents` (state bytea, updated_at), `yjs_snapshots` (future versioning)
- `domain/acl.ts` with role → permission map; exhaustive ACL test matrix
- REST: list (owned + shared), create, rename, delete (owner), list/add/remove/change-role members (by email)
- Web: workbook listing page (cards/table, create, delete with confirm, "Shared with me", members dialog)
  **Done when:** user A creates a workbook and shares it with user B as viewer; B sees it, cannot delete it.

## M3 — Realtime document backbone

- `packages/shared/doc-schema`: typed accessors over the Y.Doc schema (see PROJECT_CONTEXT §3.1), `createEmptyWorkbook()` (one sheet)
- Hocuspocus on `/collab`: `onAuthenticate` (cookie → session → role, readOnly for viewers), Database extension (load/store bytea, debounced), periodic snapshots
- Pg pool `min: 0` + idle timeout (lets Railway sleep)
- Web `crdt/` layer: provider lifecycle per workbook route, `useDocValue` hooks via `useSyncExternalStore`, connection status → Redux
- Server e2e: two Node clients converge; viewer update is dropped; restart server → state persists
  **Done when:** two browsers on the same workbook see a test value sync live.

## M4a — Grid port + view model (no AG Grid yet)

- `grid/port`: `GridView` interface, events, types (ADR-0001); `fake` adapter with deterministic geometry
- Port contract test suite (runs against `fake` now, every real adapter later)
- `grid/model`: `SheetViewModel` (index ⇄ id mapping, `getCell` render data, change events → `refreshCells`)
- `packages/shared/formula-refs`: A1 ⇄ id-ref codec (property-tested round-trips, `#REF!` on deleted refs)
- `engine/`: HyperFormula adapter — initial load from doc, incremental updates from Yjs events, recalculated cells reported as changes
- ESLint `no-restricted-imports` rule for `ag-grid-*` in place before the dependency is added
  **Done when:** a Vitest test edits A2 in a Y.Doc and the fake adapter receives a refresh for the `=SUM(A1:A3)` cell.

## M4b — AG Grid Community adapter + core interaction

- `adapters/ag-grid`: render-only config (readOnlyEdit, keyboard suppressed, pinned row-index column, A/B/C headers, targeted `refreshCells`); passes the contract suite in Playwright component tests
- Cell renderer emits `role="gridcell"` + `data-row`/`data-col`; `GridPage` page object for e2e
- Default sheet size 100×26: row/col ids are created up front by the server (lazy creation on first write corrupts row positions under concurrent first writes); growing past it is an explicit insert (M7)
- `interaction/`: selection model (single cell + range via drag and Shift+arrows, stored as ids in Redux), keyboard map (arrows, Enter, Tab, Esc, F2, Delete)
- `overlay/`: selection rectangle aligned via `getCellRect` + scroll events; floating cell editor (raw input/formula)
  **Done when:** `=SUM(A1:A3)` updates live when a collaborator changes A2, and a range can be selected and cleared in one undoable step.

## M5 — Workbook page & sheet tabs

- Empty initial state (new workbook = one empty sheet), workbook rename in header (via `PATCH /api/workbooks/:id`; the name lives in Postgres, not the Y.Doc)
- Bottom tab bar: add, rename (double-click), hide/unhide, delete (confirm; can't delete last visible), switch, reorder (drag)
- Cross-sheet references (`Sheet2!A1`) in the codec and HyperFormula
  **Done when:** Playwright covers the full sheet lifecycle with a simulated remote user renaming a tab.

## M6 — Formatting, formula bar, undo/redo

- Toolbar: background color, bold, italic, underline — applied to the current selection in one transaction
- Formula bar: shows raw input (A1 formulas) of the active cell, edits commit through the same path as the cell editor
- `Y.UndoManager` scoped to LOCAL_ORIGIN, one undo step per action (`captureTimeout: 0`), Ctrl/Cmd+Z / Shift+Z, toolbar buttons; selection restored on undo via stack-item metadata
- Multi-cell actions (paste range, clear range) = one transaction = one undo step
- Clipboard: copy/cut/paste ranges as TSV (interop with Excel/Sheets) plus an HTML payload carrying raw inputs and formats for pastes within the app; formula references shifted by our own `shiftFormula` in the shared codec (HyperFormula's copy/paste only works inside its own clipboard, so it can't handle external text or cut)
- Fill handle in `overlay/` + `interaction/`: drag to extend, linear series detection, formulas shifted relatively; one Command per fill
  **Done when:** a collaborator's edits are never undone by your undo, and fill-down of `=A1*2` over 10 rows produces correct relative refs (both tested in e2e).

## M7 — Row/column structure operations

- Insert above/below/left/right (N rows/cols for an N-row/col selection), delete; our own context menu in `overlay/` (+ Ctrl+Alt+= / Ctrl+Alt+-); size cap 10,000 rows × 500 columns per sheet
- All structure ops touch only order arrays (plus removing a deleted row/col's cells, formats and sizes in the same transaction); formulas keep pointing at the right cells; deleted single-cell refs → `#REF!`; a range whose first/last row/col is deleted shrinks to the nearest surviving one inside it, as in Excel (decided 2026-11-08); a fully deleted range → `#REF!`
- Reordering is deferred (see future scope); AG Grid's own column drag is switched off so a header drag doesn't pretend to move a column
- Column width / row height resize (persisted in doc)
  **Done when:** concurrent "insert row" + "edit cell below it" from two clients converge to the correct result (server e2e + Playwright).

## M8 — Resilience & presence

- Sync status indicator (Saved / Saving / Offline / Reconnecting); y-indexeddb offline cache
- Typed WS close codes → banners; access-revoked flow (recovery export, read-only reload)
- Server persistence retry/backoff; structured logging (pino)
- Error boundaries around grid and formula engine
- Awareness: collaborator avatars and colored cell cursors
- Cold-start UX ("Waking up…") for Railway sleep
  **Done when:** Playwright simulates offline → edits → reconnect, and server-kick scenarios, with correct UI.

## M9 — Production hardening

- Security: helmet headers, CSRF considerations for cookie auth, input size limits, doc size cap, rate limits
- Neon pooled connection, backups check, migration safety in deploy
- Basic analytics/logging, README with screenshots, license decision (GPLv3-compatible due to HyperFormula)

## Future scope

- Version history (browse/restore snapshots), named versions
- Conflict visualization ("A and B edited this cell")
- Copy/paste with formatting (HTML clipboard), multi-range selection, number formats, frozen panes, more formats
- Second grid adapter (e.g. Glide Data Grid) if AG Grid Community limits us
- Email invites, link sharing, comments
- Server-side HyperFormula for exports (CSV/XLSX)
- Cut/paste rewriting references: after a cut-paste, other formulas that pointed at the moved cells still point at the (now empty) source cells; Excel redirects them
- Fill handle double-click (auto-fill down to the end of the adjacent data)
- Reorder rows/columns by dragging selected headers (Sheets-style), built on the port's pointer events for both axes; the order arrays already de-duplicate concurrent moves on read (deferred from M7, 2026-11-08)
- Unique sheet names under concurrency: two users adding or renaming sheets at the same instant can end up with two sheets of the same name (each client only checks its own copy). Existing formulas are unaffected because they store sheet ids; a newly typed `Name!A1` resolves to the first matching sheet in tab order, the same on every client. A fix would be a server-side rename of the later duplicate (e.g. "Sheet2 (2)").

---

## Main risks

| Risk                                                         | Mitigation                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Formula refs under concurrent structure edits                | id-ref storage decided up front (M4), heavily property-tested                                        |
| AG Grid Community lacks range selection / fill / clipboard   | built ourselves above the `GridView` port (ADR-0001); budget time in M4b/M6                          |
| Overlays drift from the grid on scroll/resize/pinned columns | overlay positions derived only from `getCellRect` + scroll events; dedicated Playwright scroll tests |
| Grid lock-in creeps back                                     | ESLint import ban + port contract suite + library-free e2e selectors                                 |
| Large docs (many cells) slow load/HyperFormula               | lazy ids, sparse cells map, doc size cap, measure in M4                                              |
| Railway won't sleep (open connections)                       | pool `min: 0`, DB-free health check; verify sleep in M3                                              |
| GPL obligations from HyperFormula                            | choose license before going public (M9)                                                              |
