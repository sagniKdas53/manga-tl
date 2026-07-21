--
-- PostgreSQL database dump
--

\restrict eOlyiAbDGRH6LrQFm6nu7Zv20f31x3z8Gvna5tuiqUWOMseDIVYRLLVxBcW56CJ

-- Dumped from database version 15.18
-- Dumped by pg_dump version 15.18

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: chapters; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.chapters (
    id uuid NOT NULL,
    chapter_number double precision NOT NULL,
    cover_image_id uuid,
    created_at timestamp(6) with time zone NOT NULL,
    ocr_model character varying(255),
    ocr_provider character varying(255),
    qa_llm_model character varying(255),
    qa_mode character varying(255),
    qa_provider character varying(255),
    qa_vlm_model character varying(255),
    summary_generated_at timestamp(6) with time zone,
    summary_json jsonb,
    title character varying(255),
    tl_model character varying(255),
    tl_provider character varying(255),
    updated_at timestamp(6) with time zone NOT NULL,
    use_context_memory boolean DEFAULT true NOT NULL,
    use_fallback_models boolean DEFAULT true NOT NULL,
    routing_strategy character varying(255),
    series_id uuid NOT NULL
);


ALTER TABLE public.chapters OWNER TO tladmin;

--
-- Name: conversation_regions; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.conversation_regions (
    conversation_id uuid NOT NULL,
    region_id uuid NOT NULL,
    "position" integer NOT NULL
);


ALTER TABLE public.conversation_regions OWNER TO tladmin;

--
-- Name: conversations; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.conversations (
    id uuid NOT NULL,
    scene_type character varying(255) NOT NULL,
    image_id uuid NOT NULL
);


ALTER TABLE public.conversations OWNER TO tladmin;

--
-- Name: flyway_schema_history; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.flyway_schema_history (
    installed_rank integer NOT NULL,
    version character varying(50),
    description character varying(200) NOT NULL,
    type character varying(20) NOT NULL,
    script character varying(1000) NOT NULL,
    checksum integer,
    installed_by character varying(100) NOT NULL,
    installed_on timestamp without time zone DEFAULT now() NOT NULL,
    execution_time integer NOT NULL,
    success boolean NOT NULL
);


ALTER TABLE public.flyway_schema_history OWNER TO tladmin;

--
-- Name: images; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.images (
    id uuid NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    filename character varying(255) NOT NULL,
    hash character varying(255),
    height integer,
    last_edited_at timestamp(6) with time zone,
    last_rendered_at timestamp(6) with time zone,
    storage_path character varying(255) NOT NULL,
    thumbnail_storage_path character varying(255),
    width integer,
    created_by uuid
);


ALTER TABLE public.images OWNER TO tladmin;

--
-- Name: job_costs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.job_costs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    job_id text,
    image_id uuid NOT NULL,
    provider text,
    model text,
    prompt_tokens integer,
    completion_tokens integer,
    estimated_cost double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.job_costs OWNER TO postgres;

--
-- Name: jobs; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.jobs (
    id character varying(255) NOT NULL,
    attempt integer,
    created_at timestamp(6) with time zone,
    error text,
    image_id uuid,
    max_attempts integer,
    payload text,
    status character varying(255) NOT NULL,
    trace_id character varying(255),
    type character varying(255) NOT NULL,
    updated_at timestamp(6) with time zone
);


ALTER TABLE public.jobs OWNER TO tladmin;

--
-- Name: layer_edit_history; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.layer_edit_history (
    id uuid NOT NULL,
    edited_at timestamp(6) with time zone NOT NULL,
    new_value_json jsonb,
    previous_value_json jsonb,
    edited_by uuid,
    layer_element_id uuid NOT NULL
);


ALTER TABLE public.layer_edit_history OWNER TO tladmin;

--
-- Name: layer_elements; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.layer_elements (
    id uuid NOT NULL,
    auto_size boolean,
    background_color character varying(255),
    box_shape character varying(255),
    edited_at timestamp(6) with time zone,
    font character varying(255),
    font_style character varying(255),
    font_weight character varying(255),
    is_manually_edited boolean,
    mask_polygon jsonb,
    max_height integer,
    max_width integer,
    overflow boolean,
    rotation double precision,
    size double precision,
    text text,
    text_color character varying(255),
    visible boolean,
    word_wrap boolean,
    x double precision NOT NULL,
    y double precision NOT NULL,
    layer_id uuid NOT NULL,
    region_id uuid
);


ALTER TABLE public.layer_elements OWNER TO tladmin;

--
-- Name: layers; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.layers (
    id uuid NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    metadata_json jsonb,
    target_language character varying(255),
    type character varying(255) NOT NULL,
    visible boolean,
    z_order integer NOT NULL,
    image_id uuid NOT NULL
);


ALTER TABLE public.layers OWNER TO tladmin;

--
-- Name: ocr_regions; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.ocr_regions (
    id uuid NOT NULL,
    approved boolean,
    background_color character varying(255),
    bbox_h integer NOT NULL,
    bbox_w integer NOT NULL,
    bbox_x integer NOT NULL,
    bbox_y integer NOT NULL,
    bubble_h integer,
    bubble_id character varying(255),
    bubble_reading_order integer,
    bubble_w integer,
    bubble_x integer,
    bubble_y integer,
    confidence double precision,
    detected_language character varying(255) NOT NULL,
    detection_confidence double precision,
    mask_polygon jsonb,
    ocr_score double precision,
    panel_reading_order integer,
    qa_feedback text,
    qa_score double precision,
    qa_status character varying(255),
    region_type character varying(255),
    rotation double precision,
    safe_text_h integer,
    safe_text_w integer,
    safe_text_x integer,
    safe_text_y integer,
    text text,
    translated_text text,
    translation_failed boolean,
    translation_score double precision,
    image_id uuid NOT NULL,
    panel_id uuid
);


ALTER TABLE public.ocr_regions OWNER TO tladmin;

--
-- Name: pages; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.pages (
    id uuid NOT NULL,
    page_number integer NOT NULL,
    chapter_id uuid NOT NULL,
    image_id uuid NOT NULL
);


ALTER TABLE public.pages OWNER TO tladmin;

--
-- Name: panels; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.panels (
    id uuid NOT NULL,
    bbox_h integer NOT NULL,
    bbox_w integer NOT NULL,
    bbox_x integer NOT NULL,
    bbox_y integer NOT NULL,
    grid_col integer,
    grid_row integer,
    reading_order integer NOT NULL,
    image_id uuid NOT NULL
);


ALTER TABLE public.panels OWNER TO tladmin;

--
-- Name: queue_job; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.queue_job (
    id character varying(255) NOT NULL,
    created_at timestamp(6) with time zone,
    image_id uuid,
    payload text,
    region_id uuid,
    status character varying(255),
    type character varying(255),
    updated_at timestamp(6) with time zone
);


ALTER TABLE public.queue_job OWNER TO tladmin;

--
-- Name: search_index; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.search_index (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    image_id uuid NOT NULL,
    language text NOT NULL,
    content text NOT NULL,
    content_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.search_index OWNER TO tladmin;

--
-- Name: series; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.series (
    id uuid NOT NULL,
    cover_image_id uuid,
    created_at timestamp(6) with time zone NOT NULL,
    metadata_json jsonb,
    ocr_model character varying(255),
    ocr_provider character varying(255),
    original_language character varying(255) NOT NULL,
    qa_llm_model character varying(255),
    qa_mode character varying(255),
    qa_provider character varying(255),
    qa_vlm_model character varying(255),
    reading_direction character varying(255) NOT NULL,
    source_language character varying(255),
    target_language character varying(255),
    title character varying(255) NOT NULL,
    tl_model character varying(255),
    tl_provider character varying(255),
    updated_at timestamp(6) with time zone NOT NULL,
    routing_strategy character varying(255),
    use_fallback_models boolean DEFAULT true NOT NULL,
    created_by uuid
);


ALTER TABLE public.series OWNER TO tladmin;

--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.system_settings (
    setting_key character varying(255) NOT NULL,
    setting_value character varying(255) NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL
);


ALTER TABLE public.system_settings OWNER TO tladmin;

--
-- Name: translation_regions; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.translation_regions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    translation_id uuid NOT NULL,
    region_id uuid NOT NULL,
    source_text text,
    translated_text text,
    translation_notes text,
    emotion text,
    tone text,
    confidence double precision,
    is_manually_edited boolean DEFAULT false,
    edited_at timestamp with time zone,
    edited_by uuid
);


ALTER TABLE public.translation_regions OWNER TO tladmin;

--
-- Name: translations; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.translations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    conversation_id uuid NOT NULL,
    source_language text NOT NULL,
    target_language text NOT NULL,
    is_intermediate_translation boolean DEFAULT false,
    model text,
    version integer DEFAULT 1 NOT NULL,
    is_current boolean DEFAULT true,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.translations OWNER TO tladmin;

--
-- Name: users; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    display_name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(255) NOT NULL
);


ALTER TABLE public.users OWNER TO tladmin;

--
-- Name: volumes; Type: TABLE; Schema: public; Owner: tladmin
--

CREATE TABLE public.volumes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    series_id uuid NOT NULL,
    volume_number integer NOT NULL,
    title text
);


ALTER TABLE public.volumes OWNER TO tladmin;

--
-- Name: chapters chapters_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.chapters
    ADD CONSTRAINT chapters_pkey PRIMARY KEY (id);


--
-- Name: conversation_regions conversation_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.conversation_regions
    ADD CONSTRAINT conversation_regions_pkey PRIMARY KEY (conversation_id, region_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: flyway_schema_history flyway_schema_history_pk; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.flyway_schema_history
    ADD CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank);


--
-- Name: images images_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.images
    ADD CONSTRAINT images_pkey PRIMARY KEY (id);


--
-- Name: job_costs job_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_costs
    ADD CONSTRAINT job_costs_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: layer_edit_history layer_edit_history_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layer_edit_history
    ADD CONSTRAINT layer_edit_history_pkey PRIMARY KEY (id);


--
-- Name: layer_elements layer_elements_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layer_elements
    ADD CONSTRAINT layer_elements_pkey PRIMARY KEY (id);


--
-- Name: layers layers_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layers
    ADD CONSTRAINT layers_pkey PRIMARY KEY (id);


--
-- Name: ocr_regions ocr_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.ocr_regions
    ADD CONSTRAINT ocr_regions_pkey PRIMARY KEY (id);


--
-- Name: pages pages_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_pkey PRIMARY KEY (id);


--
-- Name: panels panels_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.panels
    ADD CONSTRAINT panels_pkey PRIMARY KEY (id);


--
-- Name: queue_job queue_job_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.queue_job
    ADD CONSTRAINT queue_job_pkey PRIMARY KEY (id);


--
-- Name: search_index search_index_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.search_index
    ADD CONSTRAINT search_index_pkey PRIMARY KEY (id);


--
-- Name: series series_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.series
    ADD CONSTRAINT series_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (setting_key);


--
-- Name: translation_regions translation_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.translation_regions
    ADD CONSTRAINT translation_regions_pkey PRIMARY KEY (id);


--
-- Name: translations translations_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.translations
    ADD CONSTRAINT translations_pkey PRIMARY KEY (id);


--
-- Name: users uk_6dotkott2kjsp8vw4d0m25fb7; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT uk_6dotkott2kjsp8vw4d0m25fb7 UNIQUE (email);


--
-- Name: pages ukrurl6v5n4lkcpgcveglho9kct; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT ukrurl6v5n4lkcpgcveglho9kct UNIQUE (chapter_id, page_number);


--
-- Name: chapters uktnbdlppu59akux8v9ns6cqnht; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.chapters
    ADD CONSTRAINT uktnbdlppu59akux8v9ns6cqnht UNIQUE (series_id, chapter_number);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: volumes volumes_pkey; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.volumes
    ADD CONSTRAINT volumes_pkey PRIMARY KEY (id);


--
-- Name: volumes volumes_series_id_volume_number_key; Type: CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.volumes
    ADD CONSTRAINT volumes_series_id_volume_number_key UNIQUE (series_id, volume_number);


--
-- Name: flyway_schema_history_s_idx; Type: INDEX; Schema: public; Owner: tladmin
--

CREATE INDEX flyway_schema_history_s_idx ON public.flyway_schema_history USING btree (success);


--
-- Name: idx_job_costs_image; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_job_costs_image ON public.job_costs USING btree (image_id);


--
-- Name: layer_elements fk7qyvypb91ygmpsr7fdb7uqblm; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layer_elements
    ADD CONSTRAINT fk7qyvypb91ygmpsr7fdb7uqblm FOREIGN KEY (layer_id) REFERENCES public.layers(id) ON DELETE CASCADE;


--
-- Name: conversations fka6hou4fwxlrlvitp3rubjjf8c; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT fka6hou4fwxlrlvitp3rubjjf8c FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: layers fkau8kwbguf2qow98iracihu77n; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layers
    ADD CONSTRAINT fkau8kwbguf2qow98iracihu77n FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: panels fkb3niaaf0w6mihxyi333g41bd6; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.panels
    ADD CONSTRAINT fkb3niaaf0w6mihxyi333g41bd6 FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: pages fkffjcfkm11uokm4hqkj7congun; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT fkffjcfkm11uokm4hqkj7congun FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE CASCADE;


--
-- Name: pages fki0j04aiibciea31rbwukp7x3; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT fki0j04aiibciea31rbwukp7x3 FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: series fkit9xuhijj1sr30xihwikew938; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.series
    ADD CONSTRAINT fkit9xuhijj1sr30xihwikew938 FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: ocr_regions fkk0ts4meid7kfysedx1cafn2vc; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.ocr_regions
    ADD CONSTRAINT fkk0ts4meid7kfysedx1cafn2vc FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: chapters fklni0nmcuoug1owwvftxhess9k; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.chapters
    ADD CONSTRAINT fklni0nmcuoug1owwvftxhess9k FOREIGN KEY (series_id) REFERENCES public.series(id) ON DELETE CASCADE;


--
-- Name: layer_elements fko8nydt1pgfewqm1gm57i78fip; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layer_elements
    ADD CONSTRAINT fko8nydt1pgfewqm1gm57i78fip FOREIGN KEY (region_id) REFERENCES public.ocr_regions(id);


--
-- Name: images fkp1m9f9rm7xy8nk7a820dvh6c4; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.images
    ADD CONSTRAINT fkp1m9f9rm7xy8nk7a820dvh6c4 FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: layer_edit_history fkrmw18ccw1ycma9r1kj9p1dwov; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layer_edit_history
    ADD CONSTRAINT fkrmw18ccw1ycma9r1kj9p1dwov FOREIGN KEY (layer_element_id) REFERENCES public.layer_elements(id) ON DELETE CASCADE;


--
-- Name: layer_edit_history fks18okmd6rg7202f0rv03v9rgh; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.layer_edit_history
    ADD CONSTRAINT fks18okmd6rg7202f0rv03v9rgh FOREIGN KEY (edited_by) REFERENCES public.users(id);


--
-- Name: ocr_regions fktpw0jna8ias7s8htrwrtlx3kw; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.ocr_regions
    ADD CONSTRAINT fktpw0jna8ias7s8htrwrtlx3kw FOREIGN KEY (panel_id) REFERENCES public.panels(id);


--
-- Name: job_costs job_costs_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_costs
    ADD CONSTRAINT job_costs_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: job_costs job_costs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_costs
    ADD CONSTRAINT job_costs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: translation_regions translation_regions_translation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: tladmin
--

ALTER TABLE ONLY public.translation_regions
    ADD CONSTRAINT translation_regions_translation_id_fkey FOREIGN KEY (translation_id) REFERENCES public.translations(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict eOlyiAbDGRH6LrQFm6nu7Zv20f31x3z8Gvna5tuiqUWOMseDIVYRLLVxBcW56CJ

