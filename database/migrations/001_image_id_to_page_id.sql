-- Migration: Replace image_id with page_id in layers, conversations, and ocr_regions
-- Run this before deploying the updated backend (or after, if the backend fails to start)

BEGIN;

-- 1. Add page_id columns (nullable initially)
ALTER TABLE public.layers ADD COLUMN page_id uuid;
ALTER TABLE public.conversations ADD COLUMN page_id uuid;
ALTER TABLE public.ocr_regions ADD COLUMN page_id uuid;

-- 2. Populate page_id by joining through the pages table
UPDATE public.layers l
SET page_id = p.id
FROM public.pages p
WHERE p.image_id = l.image_id;

UPDATE public.conversations c
SET page_id = p.id
FROM public.pages p
WHERE p.image_id = c.image_id;

UPDATE public.ocr_regions o
SET page_id = p.id
FROM public.pages p
WHERE p.image_id = o.image_id;

-- 3. Drop old FK constraints
ALTER TABLE public.layers DROP CONSTRAINT IF EXISTS fkau8kwbguf2qow98iracihu77n;
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS fka6hou4fwxlrlvitp3rubjjf8c;
ALTER TABLE public.ocr_regions DROP CONSTRAINT IF EXISTS fkk0ts4meid7kfysedx1cafn2vc;

-- 4. Drop old image_id columns
ALTER TABLE public.layers DROP COLUMN image_id;
ALTER TABLE public.conversations DROP COLUMN image_id;
ALTER TABLE public.ocr_regions DROP COLUMN image_id;

-- 5. Set page_id to NOT NULL
ALTER TABLE public.layers ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE public.conversations ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE public.ocr_regions ALTER COLUMN page_id SET NOT NULL;

-- 6. Add new FK constraints referencing pages
ALTER TABLE public.layers
    ADD CONSTRAINT fkau8kwbguf2qow98iracihu77n FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;

ALTER TABLE public.conversations
    ADD CONSTRAINT fka6hou4fwxlrlvitp3rubjjf8c FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;

ALTER TABLE public.ocr_regions
    ADD CONSTRAINT fkk0ts4meid7kfysedx1cafn2vc FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;

COMMIT;
