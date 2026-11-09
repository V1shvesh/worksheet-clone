# Deploying to Railway + Neon

Nothing here has been run yet: the repo has never been deployed. This is the checklist for the day you decide to. Rationale for the hosting choices is in `PROJECT_CONTEXT.md` §2.3-2.4; runtime behaviour is in `docs/operations.md`. Before the first deploy, prove the image locally: `pnpm docker:up && pnpm test:smoke` (see operations.md), and resolve the open decisions in `PROJECT_CONTEXT.md` §7 (regions, repo visibility).

## 1. Neon (database)

1. Create a Neon project (free tier). Region: pick the one nearest Singapore (`aws-ap-southeast-1`), and use the same region on Railway.
2. Postgres 17. Keep the default branch/database; create a role for the app if you prefer not to use the owner.
3. From **Connect**, copy two connection strings:
   - **Pooled** (host contains `-pooler`): becomes `DATABASE_URL`.
   - **Direct / unpooled** (no `-pooler`): becomes `DATABASE_URL_UNPOOLED`. Migrations take a session-level advisory lock, which a transaction-mode pooler does not preserve.
4. Append `?sslmode=verify-full` to both. (`require` also works but `pg` warns about it.)
5. Compute autosuspend: leave the default (5 min) so the database scales to zero.

## 2. Railway (service)

1. New project -> **Deploy from GitHub repo**. `railway.toml` selects `docker/Dockerfile`, the `/api/health` health check and the restart policy. Railway builds the image itself on amd64.
2. Set the service's region to the one nearest Neon.
3. **Variables** (service -> Variables):

| Variable                | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `NODE_ENV`              | `production` (the image already sets it; set it anyway)                             |
| `DATABASE_URL`          | Neon **pooled** URL with `?sslmode=verify-full`                                     |
| `DATABASE_URL_UNPOOLED` | Neon **direct** URL with `?sslmode=verify-full`                                     |
| `COOKIE_SECRET`         | `openssl rand -base64 48` (at least 32 characters). Rotating it signs everyone out. |
| `TRUST_PROXY`           | `1` (Railway puts one proxy in front). Needed so rate limits see real client IPs.   |

`PORT` is injected by Railway and read by the server; `WEB_DIST_DIR` is set by the image. 4. **Networking**: generate a public domain. Do not add other services that talk to this one over the private network (it would keep it awake). 5. **Settings -> Serverless**: enable (the app sleeps after ~10 minutes without outbound traffic; the first request pays a cold start, the UI shows "waking up"). 6. **Usage limit**: Workspace settings -> Usage -> set a hard limit and an alert. The Hobby plan is a $5/month floor that includes $5 of usage; it is not a ceiling.

## 3. First-deploy checklist

Run in order; stop at the first failure.

- [ ] Deploy logs show `applied database migrations`, then `Server listening`. A config error prints `Invalid configuration:` with every problem and exits 1.
- [ ] `curl -i https://<domain>/api/health` is `200 {"status":"ok"}` and carries `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options: DENY`.
- [ ] Sign up a real account in the browser; reload; you are still signed in (the cookie is `Secure`, so this only works over https).
- [ ] Create a workbook and open it. The header says "All changes saved" (the WebSocket connected).
- [ ] **WebSocket Origin == Host.** `/collab` upgrades are refused with 403 unless the `Origin` host equals the `Host` header. Check in the browser's Network tab (filter WS) that the `/collab` request is `101 Switching Protocols`. If it is 403, Railway is not forwarding the public `Host` unchanged: compare the `host` value in the request log line with the public domain. Fixes, in order: remove any custom proxy/CDN in front that rewrites Host; if Railway rewrites it, the check in `apps/server/src/http/same-origin.ts` needs to read `X-Forwarded-Host` when `TRUST_PROXY` is set (a code change plus a test, not a config switch).
- [ ] Browser console: no `Content Security Policy` violations. Chromium was verified locally; Firefox and Safari were not. If one blocks the socket, add `wss://<your domain>` to `connect-src` in `apps/server/src/http/security-headers.ts`.
- [ ] Open the workbook in a second browser as a second user (add them as editor): edits sync live.
- [ ] Rate limits see real IPs: in the logs, `req.remoteAddress` of your requests is your public IP, not an internal `100.64.x.x` / `10.x` address. If every request shows the same internal address, `TRUST_PROXY` is not applied (or the hop count is wrong).
- [ ] Wait ~15 minutes idle: the service shows as sleeping, Neon shows the compute suspended. Open the site: it wakes and works.
- [ ] Run the local smoke test against the public URL once: `SMOKE_BASE_URL=https://<domain> pnpm test:smoke` (it creates two throwaway users; signup is limited to 5 per hour per IP).

## Keeping costs low

The container only sleeps when nothing keeps it busy, and an open collaboration WebSocket (which the server pings) is exactly that. So the web client hangs up when the user is away (`apps/web/src/crdt/idle.ts`): after the tab has been hidden for 5 minutes, or after 30 minutes without input in a visible tab. The header then says "Paused while you're away"; coming back (tab visible, any input, or the browser going online) reconnects and syncs anything typed meanwhile. Unconfirmed changes delay the hang-up until the server confirms them (at most 2 more minutes). The last client leaving makes the server store and unload the document, after which nothing is sent to anyone.

- Set a Railway **usage limit** (hard limit plus an alert); the Hobby plan is a floor, not a ceiling.
- Keep **Serverless** enabled on the service.
- Do not add uptime pingers or monitors that call the app: any outbound traffic keeps it awake (and `/api/health` is deliberately DB-free).
- Keep **one service** (no private-network peers).
- To pause hard, remove the active deployment (operations.md, "Pause and resume").

## 4. Day to day

Deploys happen on push to the branch Railway tracks (set it to `main`; `main` only accepts green CI). Migrations run on start, before the server listens; keep them additive (operations.md). Pause/resume, backups and restores: operations.md.
