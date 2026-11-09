#!/usr/bin/env bash
# Restores a dump made by db:dump.
#   pnpm db:restore backups/x.dump            -> into a FRESH database `worksheet_restore` on the
#                                                prod-like compose stack (dropped and recreated)
#   pnpm db:restore backups/x.dump some_name  -> same, with another database name
#   RESTORE_DATABASE_URL=postgres://... pnpm db:restore backups/x.dump
#                                             -> into that (existing, ideally empty) database;
#                                                existing objects are dropped first (--clean).
# It never touches the live `worksheet` database unless you name it yourself.
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:?usage: db:restore <dump file> [database name]}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
if [ -n "${RESTORE_DATABASE_URL:-}" ]; then
  docker run --rm -i postgres:17-alpine pg_restore --clean --if-exists --no-owner --no-privileges \
    -d "$RESTORE_DATABASE_URL" < "$file"
  echo "restored $file into RESTORE_DATABASE_URL"
else
  name="${2:-worksheet_restore}"
  dc=(docker compose -f docker/docker-compose.prod.yml exec -T db)
  "${dc[@]}" psql -U worksheet -d postgres -v ON_ERROR_STOP=1 \
    -c "drop database if exists \"$name\"" -c "create database \"$name\""
  "${dc[@]}" pg_restore -U worksheet -d "$name" --no-owner --no-privileges < "$file"
  echo "restored $file into database $name (psql -U worksheet $name)"
fi
