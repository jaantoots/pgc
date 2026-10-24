#!/usr/bin/env bash
# Regenerate docs/screenshots against a demo database.
#
# Needs a PostgreSQL server you can create a database on, found the same way
# psql finds it (PG* environment variables, defaults), plus Node.js and Rust.
#
#   tools/screenshots/run.sh            # or: make screenshots
#
# Environment:
#   PGC_DEMO_DB           demo database name (default: pgc_demo). It is dropped
#                         and recreated, but only if pgc created it.
#   PGC_SCREENSHOT_PORT   port for the temporary pgc server (default: 8799)
#   PGC_CHROMIUM          use this Chromium binary instead of Playwright's
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
db=${PGC_DEMO_DB:-pgc_demo}
port=${PGC_SCREENSHOT_PORT:-8799}
marker='pgc screenshots demo database'
out="$root/docs/screenshots"

psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }

echo "Creating demo database \"$db\"…"
existing=$(psql_admin -tAc "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '$db'")
if [ -n "$(psql_admin -tAc "select 1 from pg_database where datname = '$db'")" ]; then
  if [ "$existing" != "$marker" ]; then
    echo "error: database \"$db\" exists and wasn't created by this script; set PGC_DEMO_DB to another name" >&2
    exit 1
  fi
  psql_admin -c "drop database \"$db\""
fi
psql_admin -c "create database \"$db\"" -c "comment on database \"$db\" is '$marker'"
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/demo.sql" >/dev/null

echo "Building pgc…"
make -C "$root" web >/dev/null
cargo build --quiet --manifest-path "$root/Cargo.toml"

data=$(mktemp -d)
"$root/target/debug/pgc" --no-browser --listen "127.0.0.1:$port" --data-dir "$data" "dbname=$db" >"$data/log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true; rm -rf "$data"' EXIT
for _ in $(seq 50); do
  grep -q '^Open:' "$data/log" 2>/dev/null && break
  kill -0 $pid 2>/dev/null || { cat "$data/log" >&2; exit 1; }
  sleep 0.2
done

(cd "$here" && { [ -d node_modules/playwright ] || npm ci --silent; })
mkdir -p "$out"
echo "Taking screenshots…"
node "$here/shots.mjs" "http://localhost:$port" "$(cat "$data/token")" "$out"
echo "Wrote $out"
