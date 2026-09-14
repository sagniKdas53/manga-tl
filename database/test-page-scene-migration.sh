#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROJECT="manga-b02-${RANDOM:-$$}"
cleanup() { docker compose -p "$PROJECT" -f "$ROOT/backend-rust/scripts/test-deps.yml" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

COMPOSE="docker compose -p $PROJECT -f $ROOT/backend-rust/scripts/test-deps.yml"
$COMPOSE up -d --wait db >/dev/null


# Existing installation: baseline schema and a source image survive the idempotent upgrade.
git -C "$ROOT" show HEAD:database/init.sql \
  | sed -e '/^\\restrict/d' -e '/^\\unrestrict/d' -e 's/OWNER TO [a-zA-Z_]*;/OWNER TO postgres;/' \
  | $COMPOSE exec -T db psql -U postgres -d manga_library -v ON_ERROR_STOP=1 -f - >/dev/null
$COMPOSE exec -T db psql -U postgres -d manga_library -v ON_ERROR_STOP=1 -c "INSERT INTO images (id, created_at, filename, storage_path) VALUES ('00000000-0000-0000-0000-000000000001', now(), 'source.png', 'sources/source.png');" >/dev/null
$COMPOSE exec -T -e PGPASSWORD=testdbpass db sh /migrations/migrate.sh >/dev/null
$COMPOSE exec -T db psql -U postgres -d manga_library -tAc "SELECT count(*) FROM images WHERE id = '00000000-0000-0000-0000-000000000001'" | grep -qx 1
$COMPOSE exec -T db psql -U postgres -d manga_library -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('page_scene_snapshots', 'page_scene_owners', 'page_scene_assets', 'page_render_jobs')" | grep -qx 4

# Fresh isolated DB: current init already contains the exact new storage contract.
$COMPOSE exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE page_scene_fresh;' >/dev/null
sed -e '/^\\restrict/d' -e '/^\\unrestrict/d' -e 's/OWNER TO [a-zA-Z_]*;/OWNER TO postgres;/' "$ROOT/database/init.sql" \
  | $COMPOSE exec -T db psql -U postgres -d page_scene_fresh -v ON_ERROR_STOP=1 -f - >/dev/null
$COMPOSE exec -T db psql -U postgres -d page_scene_fresh -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'scene_revision'" | grep -qx 1
$COMPOSE exec -T db psql -U postgres -d page_scene_fresh -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('page_scene_snapshots', 'page_scene_owners', 'page_scene_assets', 'page_render_jobs')" | grep -qx 4

echo 'page-scene migration: PASS'
