BEGIN;

ALTER TABLE public.ocr_regions
    ADD COLUMN IF NOT EXISTS ownership_provenance jsonb;

COMMIT;
