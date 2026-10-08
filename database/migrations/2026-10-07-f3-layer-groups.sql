-- F3 (#178): layer groups. init.sql has the column and constraint (LOCK-3); a database that keeps
-- its data takes this file. Safe to re-run.
--
--   docker compose exec -T db psql -U tladmin -d manga_library -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-07-f3-layer-groups.sql

BEGIN;

ALTER TABLE public.layers ADD COLUMN IF NOT EXISTS parent_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'layers_parent_id_fkey') THEN
    ALTER TABLE ONLY public.layers
      ADD CONSTRAINT layers_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.layers(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
