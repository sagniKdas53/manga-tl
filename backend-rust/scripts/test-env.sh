#!/usr/bin/env bash
# Hermetic test runner for the Rust backend.
#
#   scripts/test-env.sh up              # start throwaway pg/valkey/minio (ports 55490/56390/19090)
#   scripts/test-env.sh run             # full gate: fmt + clippy + cargo test, hermetic env
#   scripts/test-env.sh run cargo test --test pages_endpoints
#   scripts/test-env.sh down            # stop and wipe the throwaway world
#
# Why: the serving ruststack (db 55432 / valkey 56379 / minio 19001) must never see test
# traffic — tests PUT global settings keys, delete users by prefix and can clobber the
# Redis provider catalog blob on a crash. Everything here points at the isolated
# manga-test-* containers instead; the live stack is unreachable from a test run by
# construction because every *_TEST/URL env var is pinned to the 55490-range ports.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="docker compose -p mangatest -f ${SCRIPT_DIR}/test-deps.yml"

# Ports are deliberately disjoint from the serving stack (55432/56379/19001) and from
# CI's service containers. Change them here AND in test-deps.yml together.
DB_PORT=55490
REDIS_PORT=56390
MINIO_PORT=19090

# CI-identical schema application (ci-cargo.yml): pg_dump \restrict markers abort
# psql 15 imports mid-file, and OWNER points at a role that does not exist here.
apply_schema() {
  local target_db="$1"
  # Re-entrant: test DB persists across `run` invocations (tmpfs lives while the
  # container does), so wipe the schema first — mirrors a fresh tmpfs on first boot.
  $COMPOSE exec -T db psql -U postgres -d "$target_db" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
  sed -e '/^\\restrict/d' -e '/^\\unrestrict/d' \
    -e 's/OWNER TO [a-zA-Z_]*;/OWNER TO postgres;/' \
    "${SCRIPT_DIR}/../../database/init.sql" \
    | $COMPOSE exec -T db psql -U postgres -d "$target_db" -v ON_ERROR_STOP=1 -f - >/dev/null
}

cmd_up() {
  $COMPOSE up -d --wait
  # jobs_endpoints.rs refuses any database it was not explicitly pointed at, so it
  # gets its own scratch database with the same schema as the main one.
  if ! $COMPOSE exec -T db psql -U postgres -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='manga_library_jobs_e2e'" | grep -q 1; then
    $COMPOSE exec -T db psql -U postgres -d postgres -c \
      "CREATE DATABASE manga_library_jobs_e2e;" >/dev/null
  fi
  apply_schema manga_library
  apply_schema manga_library_jobs_e2e
  echo "mangatest ready: db :${DB_PORT} · valkey :${REDIS_PORT} · minio :${MINIO_PORT}"
}

cmd_down() {
  $COMPOSE down -v --remove-orphans
}

cmd_run() {
  cmd_up >/dev/null
  export SPRING_DATASOURCE_URL="jdbc:postgresql://127.0.0.1:${DB_PORT}/manga_library"
  export SPRING_DATASOURCE_USERNAME=postgres
  export SPRING_DATASOURCE_PASSWORD=testdbpass
  export REDIS_TEST_ADDR="127.0.0.1:${REDIS_PORT}"
  export MINIO_TEST_ENDPOINT="http://127.0.0.1:${MINIO_PORT}"
  export JOBS_E2E_DATABASE_URL="postgres://postgres:testdbpass@127.0.0.1:${DB_PORT}/manga_library_jobs_e2e"
  cd "${SCRIPT_DIR}/.."
  if [ "$#" -eq 0 ]; then
    exec bash -c 'cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test'
  else
    exec "$@"
  fi
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) shift; cmd_down "$@" ;;
  run) shift; cmd_run "$@" ;;
  *)
    echo "usage: $0 {up|down|run [cmd...]}" >&2
    exit 64
    ;;
esac
