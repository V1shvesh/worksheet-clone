# syntax=docker/dockerfile:1

# The install+build stages run on the BUILDER's native platform ($BUILDPLATFORM):
# their output (JS, CSS, d.ts) is platform independent, and esbuild (a Go binary)
# crashes under QEMU emulation (`lfstack.push invalid packing`), so an
# `--platform linux/amd64` build on an Apple Silicon host would otherwise fail.
# Only the `deploy` stage (native modules such as argon2) runs for the TARGET.
FROM --platform=$BUILDPLATFORM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace (dev deps included, needed to build)
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
# packages/config is copied whole (it has no build step and is tiny): with
# injectWorkspacePackages pnpm makes a HARD COPY of it at install time, and that
# copy is never refreshed by the later `COPY . .`. A copy made from package.json
# alone has no tsconfig.base.json, which broke every `extends` of it (see
# docs/failure-log.md, 2026-11-09 Docker entry).
COPY packages/config/ packages/config/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ---- build: compile shared, server and web
FROM deps AS build
COPY . .
RUN pnpm build

# Everything `pnpm deploy` needs, minus node_modules (which are built for the
# builder's platform and must not leak into a different-arch image).
RUN mkdir /out && tar -c --exclude=node_modules --exclude=.turbo \
      package.json pnpm-workspace.yaml pnpm-lock.yaml \
      packages/config packages/shared apps/server apps/web/package.json \
    | tar -x -C /out

# ---- deploy: pruned, standalone server (prod deps + its workspace deps),
# installed for the TARGET platform so argon2's native binary matches.
FROM node:24-alpine AS deploy
RUN corepack enable
WORKDIR /repo
COPY --from=build /out ./
RUN pnpm --filter @worksheet-clone/server deploy --prod /app/server

# ---- runtime: slim image, non-root user, server + prebuilt SPA only
FROM node:24-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/web-dist
ENV PORT=3000

COPY --from=deploy --chown=app:app /app/server ./server
COPY --from=build --chown=app:app /repo/apps/web/dist ./web-dist

USER app
EXPOSE 3000
CMD ["node", "server/dist/main.js"]
