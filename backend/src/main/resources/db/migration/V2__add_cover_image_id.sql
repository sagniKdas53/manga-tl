ALTER TABLE series ADD COLUMN IF NOT EXISTS cover_image_id UUID;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS cover_image_id UUID;

-- Backfill chapter cover images (first page of each chapter)
UPDATE chapters c
SET cover_image_id = (
    SELECT p.image_id
    FROM pages p
    WHERE p.chapter_id = c.id
    ORDER BY p.page_number ASC
    LIMIT 1
);

-- Backfill series cover images (cover image of the first chapter)
UPDATE series s
SET cover_image_id = (
    SELECT c.cover_image_id
    FROM chapters c
    WHERE c.series_id = s.id
    ORDER BY c.chapter_number ASC
    LIMIT 1
);
