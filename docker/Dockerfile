# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace (dev deps included, needed to build)
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ---- build: compile shared, server and web
FROM deps AS build
COPY . .
RUN pnpm build

# ---- deploy: produce a pruned, standalone server (prod deps + its workspace deps)
FROM build AS deploy
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
