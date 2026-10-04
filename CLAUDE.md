# Worksheet Clone — Project Conventions

Real-time, multi-user spreadsheet (Google Sheets–style) built as a personal project and deployed publicly.
Users sign up, create workbooks with multiple sheets, invite collaborators, and edit concurrently.

> Rationale for every decision below lives in `PROJECT_CONTEXT.md`. The build plan lives in `docs/PLAN.md`.
> Keep this file lean and operational.

## Always-loaded context

@PROJECT_CONTEXT.md
@docs/PLAN.md

Before any grid work, also read `docs/adr/0001-grid-abstraction.md`.

## How we work

- **Plan first.** Before each milestone (or any non-trivial change), propose a plan for that milestone only and wait for approval. Do not start coding a milestone unprompted.
- **Small, verified commits.** One working piece per commit, all quality gates green, then move on. Commit messages say what and why; new dependencies get a one-line justification.
- **Self-verify.** Run the checks listed under "How to verify your own work" before claiming something works.
- **Failure log.** When an AI-assisted change goes wrong in a surprising way, add one line to `docs/failure-log.md`.
- **Keep status current.** At the end of a milestone, update "Current status" below and the status narrative in `PROJECT_CONTEXT.md`.
- Open decisions are listed in `PROJECT_CONTEXT.md` §7. Ask before deciding one of them.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere (`strict: true`, no `any` without a comment explaining why) |
| Monorepo | pnpm workspaces (+ Turborepo for task caching) |
| Frontend | React + Vite, Redux Toolkit (+ RTK Query for REST), HyperFormula |
| Grid | AG Grid **Community** as a render-only adapter behind our `GridView` port (ADR-0001) |
| Realtime | Yjs (CRDT) + `@hocuspocus/provider` on the client, `@hocuspocus/server` on the backend |
| Backend | Fastify (REST) + Hocuspocus (WebSocket) in one Node process |
| Database | Postgres via Drizzle ORM + `drizzle-kit` migrations; Neon in prod, Docker Postgres locally/CI |
| Validation | Zod schemas in `packages/shared`, used by both client and server |
| Auth | Email + password (argon2id), server-side sessions in Postgres, httpOnly secure cookie |
| Testing | Vitest (unit/functional, both apps), Testing Library (React), Testcontainers (backend e2e), Playwright (frontend hermetic e2e) |
| Lint/format | ESLint (typescript-eslint, react-hooks) + Prettier |
| Git hooks | Husky + lint-staged |
| Container | Single multi-stage Dockerfile → one image (Fastify serves the built SPA, REST and WS) |
| Hosting | Railway (Hobby, serverless sleep enabled) + Neon Postgres (free tier, scale-to-zero) |

## Repository layout

```
apps/
  web/                 # React SPA
    src/
      app/             # store setup, routing, providers
      features/        # auth/, workbooks/, sheet/, grid/, formula/ … (feature-sliced)
        grid/
          model/       # SheetViewModel: Yjs + HyperFormula → render data, index ⇄ id mapping
          interaction/ # selection, keyboard, fill, clipboard, editing state machines (pure TS)
          commands/    # Command → one Yjs transaction
          port/        # GridView interface, events, shared types, contract tests
          overlay/     # selection rects, fill handle, floating editor, cursors, context menu
          adapters/
            ag-grid/   # the ONLY place allowed to import ag-grid-*
            fake/      # in-memory adapter for unit tests
      crdt/            # Yjs doc access layer: typed read/write helpers, UndoManager, provider
      engine/          # HyperFormula adapter (Yjs → HF sync, A1 <-> id-ref translation)
      components/      # shared presentational components
    e2e/               # Playwright hermetic tests + fixtures/mocks
  server/
    src/
      http/            # Fastify routes (auth, workbooks, members)
      realtime/        # Hocuspocus config, auth hook, persistence extension
      db/              # Drizzle schema, migrations, queries
      domain/          # ACL rules, services (no Fastify/Hocuspocus imports here)
    test/
      functional/      # service/route tests via fastify.inject
      e2e/             # real server + Testcontainers Postgres + real WS clients
packages/
  shared/              # zod schemas, API types, Yjs document schema + typed accessors, id-ref formula codec
  config/              # shared tsconfig / eslint / prettier presets
docker/                # Dockerfile, compose files
docs/                  # PLAN.md, ADRs (docs/adr/NNNN-title.md)
```

## Conventions

- **Yjs is the source of truth for workbook content.** Redux holds UI state only (selection, active sheet, editing state, dialogs, connection status) plus RTK Query caches for REST data. Never copy the whole Y.Doc into Redux; subscribe to the slices a component needs.
- **Every user action = exactly one `doc.transact(fn, LOCAL_ORIGIN)`**. Never write to the Y.Doc outside the `crdt/` layer.
- **Computed values are never stored.** The doc stores raw input (value or formula) and formatting. HyperFormula recomputes on every client.
- **Rows and columns have stable ids.** Cells are keyed by `rowId:colId`. Formulas are stored with id-based references and translated to A1 only for display and for HyperFormula (see `packages/shared/src/formula-refs`).
- **The grid library is a dumb painter.** It never owns data, selection, editing, undo or keyboard behavior. All of that lives in `grid/interaction` + `grid/overlay`. Only `grid/adapters/ag-grid/**` may import `ag-grid-*` (enforced by ESLint `no-restricted-imports`). Coordinates crossing the port are visual indices; the adapter never sees row/col ids, Yjs or HyperFormula.
- E2E specs never use grid-library selectors: use `data-row`/`data-col`/`data-testid` via the `GridPage` page object.
- Naming: `camelCase` vars/functions, `PascalCase` components/types, `kebab-case` file names, `*.test.ts` next to the code, e2e under `e2e/`.
- Domain logic in `apps/server/src/domain` must be framework-free so it is testable without HTTP.
- Errors: REST returns `{ error: { code, message } }` with a typed `code` union from `packages/shared`.
- No new dependency without a one-line justification in the PR/commit message.
- Significant decisions get a short ADR in `docs/adr/`.

## Commands

```bash
pnpm install
pnpm dev                 # docker compose postgres + server (watch) + web (vite)
pnpm lint                # eslint, all packages
pnpm format              # prettier --write
pnpm format:check
pnpm typecheck           # tsc --noEmit, all packages (project references)
pnpm test                # vitest unit + functional, all packages
pnpm test:e2e:server     # backend e2e (needs Docker for Testcontainers)
pnpm test:e2e:web        # Playwright hermetic e2e (no backend needed)
pnpm db:generate         # drizzle-kit generate migration from schema
pnpm db:migrate          # apply migrations
pnpm docker:build        # build production image
pnpm docker:up           # run prod-like stack locally (app + postgres)
```

## Quality gates

| Where | Runs |
|---|---|
| pre-commit (Husky + lint-staged) | prettier + eslint on staged files, `pnpm typecheck`, `vitest related` on staged files |
| pre-push | `pnpm test` + `pnpm test:e2e:web` |
| CI (GitHub Actions, every push/PR) | format:check, lint, typecheck, test, test:e2e:server, test:e2e:web, docker build. **CI is the authoritative gate; main is protected.** |

Never bypass hooks with `--no-verify`. A change is done only when the relevant tests exist and pass.

## How to verify your own work

- Logic change → add/adjust a Vitest test, run `pnpm test --filter <pkg>`.
- API change → functional test with `fastify.inject`, then `pnpm test:e2e:server`.
- Grid behavior change → unit test against the `fake` adapter; adapter change → port contract suite must pass for every adapter.
- UI change → Testing Library test for behavior; Playwright spec for user flows; run `pnpm test:e2e:web`.
- Realtime change → backend e2e with two `HocuspocusProvider` clients asserting convergence.
- Before saying a milestone is done: run the full CI command set locally.

## Current status

- [x] Stack and architecture decided (see `PROJECT_CONTEXT.md`)
- [ ] M0 — Walking skeleton (repo, tooling, CI, Docker, deployed hello-world) ← **next**
- [ ] M1 — Auth
- [ ] M2 — Workbooks + ACL
- [ ] M3 — Realtime document backbone
- [ ] M4a — Grid port + view model + formula engine (no AG Grid)
- [ ] M4b — AG Grid Community adapter + selection/keyboard/editor
- [ ] M5 — Sheet tabs
- [ ] M6 — Formatting, formula bar, undo/redo, clipboard, fill handle
- [ ] M7 — Row/column structure ops
- [ ] M8 — Resilience: errors, offline, rollback, presence
- [ ] M9 — Production hardening

Update this list (and the narrative in `PROJECT_CONTEXT.md`) when a milestone completes.
