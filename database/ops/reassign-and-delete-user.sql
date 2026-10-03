-- Move everything a throwaway account owns to a real account, then delete the throwaway.
-- Tracker plan for 2026-10-03, item 6. One transaction; it stops and changes nothing unless
-- both accounts exist and differ.
--
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d manga_library \
--     -v throwaway='bunny-import-c68d0f@example.invalid' -v owner='<your account email>' \
--     -f - < database/ops/reassign-and-delete-user.sql
--
-- Every column that names a user: images.created_by, series.created_by and
-- layer_edit_history.edited_by (foreign keys), and translations.created_by (no constraint).
-- A throwaway that owns nothing (the laptop one) is deleted the same way.

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE swap ON COMMIT DROP AS
SELECT t.id AS throwaway, o.id AS owner
FROM users t, users o
WHERE t.email = :'throwaway' AND o.email = :'owner' AND t.id <> o.id;

DO $$
BEGIN
    IF (SELECT count(*) FROM swap) <> 1 THEN
        RAISE EXCEPTION 'throwaway or owner account not found (or they are the same account)';
    END IF;
END $$;

UPDATE images i SET created_by = s.owner FROM swap s WHERE i.created_by = s.throwaway;
UPDATE series r SET created_by = s.owner FROM swap s WHERE r.created_by = s.throwaway;
UPDATE layer_edit_history h SET edited_by = s.owner FROM swap s WHERE h.edited_by = s.throwaway;
UPDATE translations t SET created_by = s.owner FROM swap s WHERE t.created_by = s.throwaway;
DELETE FROM users u USING swap s WHERE u.id = s.throwaway;

COMMIT;
