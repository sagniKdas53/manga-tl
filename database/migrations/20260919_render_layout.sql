BEGIN;

-- Tracker R2 (c): the browser renderer reports the layout it resolved for every text object
-- (font px, line breaks). The ledger keeps it next to the diagnostics for the same revision.
ALTER TABLE public.page_render_jobs
    ADD COLUMN IF NOT EXISTS layout_json jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
