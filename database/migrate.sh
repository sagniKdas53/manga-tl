#!/bin/sh
set -eu

if [ -n "${PGPASSWORD_FILE:-}" ]; then
    PGPASSWORD=$(cat "$PGPASSWORD_FILE")
    export PGPASSWORD
fi

psql_cmd() {
    if [ -n "${DATABASE_URL:-}" ]; then
        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
    else
        psql \
            -h "${PGHOST:-db}" \
            -p "${PGPORT:-5432}" \
            -U "${PGUSER:-postgres}" \
            -d "${PGDATABASE:-manga_library}" \
            -v ON_ERROR_STOP=1 "$@"
    fi
}

psql_cmd -c '
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version character varying(255) PRIMARY KEY,
    applied_at timestamp(6) with time zone NOT NULL DEFAULT now()
);'

for migration in /migrations/migrations/*.sql; do
    [ -f "$migration" ] || continue
    version=$(basename "$migration")
    applied=$(psql_cmd -tAc "SELECT 1 FROM public.schema_migrations WHERE version = '$version'")
    [ "$applied" = "1" ] && continue
    psql_cmd -f "$migration"
    psql_cmd -c "INSERT INTO public.schema_migrations (version) VALUES ('$version')"
done
