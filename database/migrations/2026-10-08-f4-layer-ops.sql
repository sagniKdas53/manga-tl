-- F4 (#178): the page's layer history, for Undo and Redo of layer actions that survive a reload.
-- init.sql has the table (LOCK-3); a database that keeps its data takes this file. Safe to re-run.
--
--   docker compose exec -T db psql -U tladmin -d manga_library -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-08-f4-layer-ops.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.layer_ops (
    id uuid NOT NULL,
    page_id uuid NOT NULL,
    seq bigint GENERATED ALWAYS AS IDENTITY,
    kind character varying(32) NOT NULL,
    label text NOT NULL,
    batch character varying(64),
    created_by character varying(255),
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    undone boolean DEFAULT false NOT NULL,
    changes jsonb NOT NULL,
    CONSTRAINT layer_ops_pkey PRIMARY KEY (id),
    CONSTRAINT layer_ops_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE
);

ALTER TABLE public.layer_ops OWNER TO tladmin;

CREATE INDEX IF NOT EXISTS idx_layer_ops_page_seq ON public.layer_ops USING btree (page_id, seq);

COMMIT;
