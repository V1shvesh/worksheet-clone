#!/usr/bin/env bash
# Writes a custom-format pg_dump to backups/worksheet-<timestamp>.dump (gitignored).
#   pnpm db:dump                       dumps the prod-like compose stack's database (pnpm docker:up)
#   DATABASE_URL=postgres://... pnpm db:dump   dumps that database (e.g. Neon, UNPOOLED url preferred)
# pg_dump always runs inside a postgres:17 container, so no local client is needed
# (Neon runs Postgres 17; use a matching major version).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/worksheet-$(date +%Y%m%d-%H%M%S).dump"
flags=(--format=custom --no-owner --no-privileges)
if [ -n "${DATABASE_URL:-}" ]; then
  docker run --rm postgres:17-alpine pg_dump "${flags[@]}" "$DATABASE_URL" > "$file"
else
  docker compose -f docker/docker-compose.prod.yml exec -T db \
    pg_dump -U worksheet "${flags[@]}" worksheet > "$file"
fi
[ -s "$file" ] || { rm -f "$file"; echo "dump is empty" >&2; exit 1; }
echo "$file ($(wc -c < "$file" | tr -d ' ') bytes)"
