-- The role Grafana connects as.
--
-- Grafana panels run operator-authored SQL directly against this database, and a dashboard is
-- exactly the kind of place a half-finished query gets saved and re-run. SELECT and nothing else
-- means the worst outcome of a bad panel is a bad panel. It also cannot see the future: new tables
-- are not readable until the grant below is re-run, which is deliberate — a table should be shown
-- to the dashboard on purpose, not by default.
--
-- Not part of init.sql: that file is the schema the backend validates against on boot
-- (InitScriptReconciliationTest guards it column-for-column), and a role definition carrying a
-- password does not belong in it. Run this by hand once per deployment:
--
--   docker exec -i manga-db psql -U tladmin -d manga_library \
--     -v pw="$(cat secrets/grafana_db_password.txt)" -f - < database/grafana_readonly.sql

\set quoted_pw '''' :pw ''''

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
    CREATE ROLE grafana_ro LOGIN;
  END IF;
END
$$;

ALTER ROLE grafana_ro WITH PASSWORD :quoted_pw;

-- Connect and look, nothing more.
GRANT CONNECT ON DATABASE manga_library TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_ro;

-- Covers tables added later by the same owner. Re-run the GRANT above for anything created by a
-- different role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_ro;

-- Belt and braces: revoke the write paths a default PUBLIC grant could otherwise leave open.
REVOKE CREATE ON SCHEMA public FROM grafana_ro;
