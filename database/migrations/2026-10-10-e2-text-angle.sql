-- E2 (#180): tilted text at its angle. A turned region keeps the box along its text, and System
-- Settings' `ocrTextAngle` gets a series and a chapter override (NULL = inherit). init.sql has the
-- columns; a database that keeps its data takes this file. Safe to re-run. Nothing is backfilled:
-- a page turns its text on its next OCR (or Redo OCR).
--
--   docker compose exec -T db psql -U tladmin -d manga_library -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-10-e2-text-angle.sql

BEGIN;

ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS text_area_x double precision;
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS text_area_y double precision;
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS text_area_w double precision;
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS text_area_h double precision;

ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS ocr_text_angle boolean;
ALTER TABLE public.series ADD COLUMN IF NOT EXISTS ocr_text_angle boolean;

COMMIT;
