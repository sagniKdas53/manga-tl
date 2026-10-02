-- Upgrade a database created from `main` (before PR #152) to this branch's schema.
--
-- init.sql is the whole schema (LOCK-3) and a fresh volume needs nothing here. Production keeps
-- its data, so it takes this file instead, then the R7 backfill:
--
--   1. database/migrations/2026-10-01-upgrade-from-main.sql   (this file)
--   2. database/migrations/2026-09-27-r7-inpainting-layer.sql (finds nothing to backfill on a
--      database from main -- no page there has worker cleanup patches -- but is safe to run)
--
--   docker compose exec -T db psql -U tladmin -d manga_library -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-01-upgrade-from-main.sql
--
-- Safe to re-run: every column, table, constraint and index is added only if missing. Each
-- statement mirrors init.sql; keep the two in step. Checked by loading main's init.sql, applying
-- this file, and comparing `pg_dump --schema-only` with one made from this branch's init.sql.

BEGIN;

-- Series and chapter settings (cleanup mode, OCR grouping threshold).
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS cleanup_mode character varying(255);
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS ocr_merge_threshold double precision;
ALTER TABLE public.series ADD COLUMN IF NOT EXISTS cleanup_mode character varying(255);
ALTER TABLE public.series ADD COLUMN IF NOT EXISTS ocr_merge_threshold double precision;

-- R3 stage-attempt authority on jobs.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS input_generation integer DEFAULT 0 NOT NULL;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS lease_token character varying(255);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamp(6) with time zone;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamp(6) with time zone;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS progress_at timestamp(6) with time zone;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS progress_count integer DEFAULT 0 NOT NULL;

-- R7: an Inpainting-layer element is one cleanup patch.
ALTER TABLE public.layer_elements ADD COLUMN IF NOT EXISTS cleanup_ref jsonb;
ALTER TABLE public.layer_elements ADD COLUMN IF NOT EXISTS opacity double precision;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'layer_elements_opacity_check') THEN
        ALTER TABLE public.layer_elements ADD CONSTRAINT layer_elements_opacity_check
            CHECK (opacity IS NULL OR (opacity >= 0 AND opacity <= 1));
    END IF;
END $$;

-- R3 glyph-mask cleanup assets and fragment ownership on regions.
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS ownership_provenance jsonb;
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_mask_asset_id character varying(255);
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_mask_sha256 character(64);
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_mask_byte_length bigint;
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_patch_asset_id character varying(255);
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_patch_sha256 character(64);
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_patch_byte_length bigint;
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_bounds jsonb;
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_generator_sha256 character(64);
ALTER TABLE public.ocr_regions ADD COLUMN IF NOT EXISTS cleanup_diagnostics jsonb;

-- The page scene: revisions, generations, and the current render.
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS scene_revision integer DEFAULT 0 NOT NULL;
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS input_generation integer DEFAULT 0 NOT NULL;
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS current_render_job_id character varying(255);
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS hand_edited_at timestamp(6) with time zone;

CREATE TABLE IF NOT EXISTS public.page_scene_snapshots (
    page_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision >= 0),
    contract_version character varying(32) NOT NULL CHECK (contract_version = 'page-scene/v1'),
    source_sha256 character(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    logical_scene_sha256 character(64) NOT NULL CHECK (logical_scene_sha256 ~ '^[a-f0-9]{64}$'),
    scene_json jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT page_scene_snapshots_pkey PRIMARY KEY (page_id, revision),
    CONSTRAINT page_scene_snapshots_page_id_logical_scene_sha256_key UNIQUE (page_id, logical_scene_sha256)
);

CREATE TABLE IF NOT EXISTS public.page_scene_owners (
    page_id uuid NOT NULL,
    revision integer NOT NULL,
    owner_id character varying(256) NOT NULL,
    policy_kind character varying(32) NOT NULL,
    policy_action character varying(16) NOT NULL CHECK (policy_action IN ('preserve', 'explain', 'replace', 'review')),
    policy_override character varying(16) CHECK (policy_override IN ('preserve', 'explain', 'replace', 'review')),
    CONSTRAINT page_scene_owners_pkey PRIMARY KEY (page_id, revision, owner_id),
    CONSTRAINT page_scene_owners_snapshot_fkey FOREIGN KEY (page_id, revision) REFERENCES public.page_scene_snapshots(page_id, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.page_scene_assets (
    page_id uuid NOT NULL,
    revision integer NOT NULL,
    asset_id character varying(256) NOT NULL,
    asset_kind character varying(32) NOT NULL,
    asset_sha256 character(64) NOT NULL CHECK (asset_sha256 ~ '^[a-f0-9]{64}$'),
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    mime_type character varying(128) NOT NULL,
    storage_path text,
    CONSTRAINT page_scene_assets_pkey PRIMARY KEY (page_id, revision, asset_id),
    CONSTRAINT page_scene_assets_snapshot_fkey FOREIGN KEY (page_id, revision) REFERENCES public.page_scene_snapshots(page_id, revision) ON DELETE CASCADE
);

-- A render job goes with its page: deleting a page cascades to its snapshots, and a RESTRICT
-- here made deleting any rendered page fail.
CREATE TABLE IF NOT EXISTS public.page_render_jobs (
    job_id character varying(255) NOT NULL,
    page_id uuid NOT NULL,
    page_revision integer NOT NULL CHECK (page_revision >= 0),
    logical_scene_sha256 character(64) NOT NULL CHECK (logical_scene_sha256 ~ '^[a-f0-9]{64}$'),
    rendered_png_sha256 character(64) CHECK (rendered_png_sha256 ~ '^[a-f0-9]{64}$'),
    rendered_png_storage_path text,
    renderer_build_sha256 character(64),
    browser_build_sha256 character(64),
    status character varying(16) NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    diagnostics_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    layout_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    completed_at timestamp(6) with time zone,
    CONSTRAINT page_render_jobs_pkey PRIMARY KEY (job_id),
    CONSTRAINT page_render_jobs_snapshot_fkey FOREIGN KEY (page_id, page_revision) REFERENCES public.page_scene_snapshots(page_id, revision) ON DELETE CASCADE
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_current_render_job_fkey') THEN
        ALTER TABLE ONLY public.pages
            ADD CONSTRAINT pages_current_render_job_fkey FOREIGN KEY (current_render_job_id)
            REFERENCES public.page_render_jobs(job_id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_scene_snapshots_page_fkey') THEN
        ALTER TABLE ONLY public.page_scene_snapshots
            ADD CONSTRAINT page_scene_snapshots_page_fkey FOREIGN KEY (page_id)
            REFERENCES public.pages(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_render_jobs_job_fkey') THEN
        ALTER TABLE ONLY public.page_render_jobs
            ADD CONSTRAINT page_render_jobs_job_fkey FOREIGN KEY (job_id)
            REFERENCES public.jobs(id) ON DELETE CASCADE;
    END IF;
END $$;

-- A database already on an earlier build of this branch has the RESTRICT version.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'page_render_jobs_snapshot_fkey' AND confdeltype = 'r') THEN
        ALTER TABLE public.page_render_jobs DROP CONSTRAINT page_render_jobs_snapshot_fkey;
        ALTER TABLE public.page_render_jobs ADD CONSTRAINT page_render_jobs_snapshot_fkey
            FOREIGN KEY (page_id, page_revision) REFERENCES public.page_scene_snapshots(page_id, revision)
            ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS page_render_jobs_input_idx
    ON public.page_render_jobs USING btree (page_id, page_revision, logical_scene_sha256);

COMMIT;
