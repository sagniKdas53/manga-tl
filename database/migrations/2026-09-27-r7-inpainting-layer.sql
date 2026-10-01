-- Tracker R7 (2026-09-27): the Inpainting layer.
--
-- init.sql is the whole schema (LOCK-3); a fresh volume gets these columns from it. This file is
-- the hand-applied equivalent for a dev database that already holds pages, plus a one-off
-- backfill so pages cleaned before R7 keep their patches:
--
--   docker compose --env-file .env -p manga-quality-dev -f docker-compose.dev.yml \
--     exec -T db psql -U tladmin -d manga_library -v ON_ERROR_STOP=1 < database/migrations/2026-09-27-r7-inpainting-layer.sql
--
-- Safe to re-run: columns are added only if missing, and a page that already has an Inpainting
-- layer is skipped. On a database from `main`, run 2026-10-01-upgrade-from-main.sql first: this
-- file reads ocr_regions' cleanup columns, which main does not have.

BEGIN;

ALTER TABLE public.layer_elements ADD COLUMN IF NOT EXISTS cleanup_ref jsonb;
ALTER TABLE public.layer_elements ADD COLUMN IF NOT EXISTS opacity double precision;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'layer_elements_opacity_check') THEN
        ALTER TABLE public.layer_elements ADD CONSTRAINT layer_elements_opacity_check
            CHECK (opacity IS NULL OR (opacity >= 0 AND opacity <= 1));
    END IF;
END $$;

-- One Inpainting layer per page that has worker patches and no Inpainting layer yet.
-- The uuid is drawn after DISTINCT: gen_random_uuid() inside it would make every row distinct.
CREATE TEMP TABLE r7_pages ON COMMIT DROP AS
SELECT d.page_id, gen_random_uuid() AS layer_id
FROM (
    SELECT DISTINCT r.page_id
    FROM public.ocr_regions r
    WHERE r.cleanup_patch_sha256 IS NOT NULL
      AND r.cleanup_mask_sha256 IS NOT NULL
      AND r.cleanup_bounds IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.layers l
                      WHERE l.page_id = r.page_id AND LOWER(l.type) = 'inpainting')
) d;

INSERT INTO public.layers (id, created_at, type, visible, z_order, page_id, metadata_json)
SELECT p.layer_id, now(), 'inpainting', TRUE,
       COALESCE((SELECT MIN(z_order) - 1 FROM public.layers l WHERE l.page_id = p.page_id), 0),
       p.page_id, '{"source": "r7-backfill"}'::jsonb
FROM r7_pages p;

-- Paint order = the order the pre-R7 builder painted these patches in: the region's first visible,
-- non-empty text element on a visible translation/sfx layer, by (layer z_order, layer created_at,
-- element id). Regions it did not paint follow in reading order.
WITH text_rank AS (
    SELECT e.region_id,
           MIN(rank) AS rank
    FROM (
        SELECT e.region_id,
               ROW_NUMBER() OVER (PARTITION BY l.page_id ORDER BY l.z_order, l.created_at, e.id) AS rank
        FROM public.layer_elements e
        JOIN public.layers l ON l.id = e.layer_id
        WHERE l.visible = TRUE AND LOWER(l.type) IN ('translation', 'sfx')
          AND COALESCE(e.visible, TRUE) = TRUE
          AND btrim(COALESCE(e.text, '')) <> ''
          AND e.region_id IS NOT NULL
    ) e
    GROUP BY e.region_id
),
reading_rank AS (
    SELECT r.id AS region_id,
           ROW_NUMBER() OVER (PARTITION BY r.page_id
                              ORDER BY r.panel_reading_order NULLS LAST, r.bubble_reading_order NULLS LAST, r.id) AS rank
    FROM public.ocr_regions r
)
INSERT INTO public.layer_elements (id, x, y, max_width, max_height, rotation, visible, auto_size, word_wrap,
                                   overflow, is_manually_edited, layer_id, region_id, cleanup_ref, opacity)
SELECT gen_random_uuid(),
       (r.cleanup_bounds->>'x')::double precision,
       (r.cleanup_bounds->>'y')::double precision,
       round((r.cleanup_bounds->>'width')::double precision)::integer,
       round((r.cleanup_bounds->>'height')::double precision)::integer,
       0, TRUE, FALSE, FALSE, FALSE, FALSE,
       p.layer_id, r.id,
       jsonb_build_object(
           'patchSha256', r.cleanup_patch_sha256,
           'patchByteLength', COALESCE(r.cleanup_patch_byte_length, 0),
           'maskSha256', r.cleanup_mask_sha256,
           'maskByteLength', COALESCE(r.cleanup_mask_byte_length, 0),
           'generatorSha256', COALESCE(r.cleanup_generator_sha256, repeat('0', 64)),
           'bounds', r.cleanup_bounds,
           'order', COALESCE(t.rank, 100000 + rr.rank)),
       NULL
FROM public.ocr_regions r
JOIN r7_pages p ON p.page_id = r.page_id
JOIN reading_rank rr ON rr.region_id = r.id
LEFT JOIN text_rank t ON t.region_id = r.id
WHERE r.cleanup_patch_sha256 IS NOT NULL
  AND r.cleanup_mask_sha256 IS NOT NULL
  AND r.cleanup_bounds IS NOT NULL
  AND round((r.cleanup_bounds->>'width')::double precision) > 0
  AND round((r.cleanup_bounds->>'height')::double precision) > 0;

COMMIT;
