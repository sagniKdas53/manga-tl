-- #226: one-shots. A one-shot is a series of kind 'oneshot' holding exactly one chapter, so
-- chapters.series_id stays NOT NULL. Existing rows become 'series' and nothing else changes.
-- init.sql has the column; a database that keeps its data takes this file. Safe to re-run.
--
--   docker compose exec -T db psql -U tladmin -d manga_library -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-19-oneshot-series-kind.sql

BEGIN;

ALTER TABLE public.series
    ADD COLUMN IF NOT EXISTS kind character varying(16) DEFAULT 'series' NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'series_kind_check') THEN
        ALTER TABLE public.series
            ADD CONSTRAINT series_kind_check CHECK (kind IN ('series', 'oneshot'));
    END IF;
END $$;

COMMIT;
