#!/bin/sh
# E0 (#180): dump the OCR regions (with their pieces) of the E test pages from the F test stack's
# database, read-only, as JSON for check_test_pages.py. Runs on chrome-box:
#   sh export_regions.sh > test_regions.json
# Add a page by adding its series title and page number to the WHERE clause.
c=manga-f-20261007-db-1
U=$(docker exec $c printenv POSTGRES_USER)
D=$(docker exec $c printenv POSTGRES_DB)
docker exec $c psql -U "$U" -d "$D" -tAc "
SELECT json_agg(t) FROM (
  SELECT s.title, p.page_number, r.id, r.text, r.region_type,
         r.bbox_x, r.bbox_y, r.bbox_w, r.bbox_h, r.ownership_provenance
  FROM ocr_regions r
  JOIN pages p ON p.id = r.page_id
  JOIN chapters c ON c.id = p.chapter_id
  JOIN series s ON s.id = c.series_id
  WHERE s.title LIKE 'E rotation%'
     OR (s.title = 'B #230 test (ja) 2026-10-06' AND p.page_number IN (2, 14, 19))
     OR (s.title = 'B fixtures (ja) 2026-10-06' AND p.page_number = 5)
) t"
