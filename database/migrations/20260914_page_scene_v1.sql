BEGIN;

ALTER TABLE public.pages
    ADD COLUMN IF NOT EXISTS scene_revision integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.page_scene_snapshots (
    page_id uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision >= 0),
    contract_version character varying(32) NOT NULL CHECK (contract_version = 'page-scene/v1'),
    source_sha256 character(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    logical_scene_sha256 character(64) NOT NULL CHECK (logical_scene_sha256 ~ '^[a-f0-9]{64}$'),
    scene_json jsonb NOT NULL,
    created_at timestamp(6) with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, revision),
    UNIQUE (page_id, logical_scene_sha256)
);

CREATE TABLE IF NOT EXISTS public.page_scene_owners (
    page_id uuid NOT NULL,
    revision integer NOT NULL,
    owner_id character varying(256) NOT NULL,
    policy_kind character varying(32) NOT NULL,
    policy_action character varying(16) NOT NULL CHECK (policy_action IN ('preserve', 'explain', 'replace', 'review')),
    policy_override character varying(16) CHECK (policy_override IN ('preserve', 'explain', 'replace', 'review')),
    PRIMARY KEY (page_id, revision, owner_id),
    FOREIGN KEY (page_id, revision) REFERENCES public.page_scene_snapshots(page_id, revision) ON DELETE CASCADE
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
    PRIMARY KEY (page_id, revision, asset_id),
    FOREIGN KEY (page_id, revision) REFERENCES public.page_scene_snapshots(page_id, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.page_render_jobs (
    job_id character varying(255) PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
    page_id uuid NOT NULL,
    page_revision integer NOT NULL CHECK (page_revision >= 0),
    logical_scene_sha256 character(64) NOT NULL CHECK (logical_scene_sha256 ~ '^[a-f0-9]{64}$'),
    rendered_png_sha256 character(64) CHECK (rendered_png_sha256 ~ '^[a-f0-9]{64}$'),
    renderer_build_sha256 character(64),
    browser_build_sha256 character(64),
    status character varying(16) NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    diagnostics_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp(6) with time zone NOT NULL DEFAULT now(),
    completed_at timestamp(6) with time zone,
    FOREIGN KEY (page_id, page_revision) REFERENCES public.page_scene_snapshots(page_id, revision) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS page_render_jobs_input_idx
    ON public.page_render_jobs (page_id, page_revision, logical_scene_sha256);

COMMIT;
