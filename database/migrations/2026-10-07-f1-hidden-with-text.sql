-- #237 (F1): hiding a region's text hides its cleanup patch too, and showing the text brings back
-- only a patch that this hid. init.sql has the column (LOCK-3); a database that keeps its data
-- takes this file. Safe to re-run.
--
--   docker compose exec -T db psql -U tladmin -d manga_library -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-07-f1-hidden-with-text.sql

ALTER TABLE public.layer_elements ADD COLUMN IF NOT EXISTS hidden_with_text boolean;
