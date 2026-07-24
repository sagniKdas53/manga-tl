CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

CREATE TABLE public.users (
    id uuid NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    display_name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(255) NOT NULL,
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT uk_6dotkott2kjsp8vw4d0m25fb7 UNIQUE (email)
);

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
    use_fallback_models boolean DEFAULT true,
    created_by uuid,
    CONSTRAINT series_pkey PRIMARY KEY (id),
    CONSTRAINT fkit9xuhijj1sr30xihwikew938 FOREIGN KEY (created_by) REFERENCES public.users(id)
);

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
    use_fallback_models boolean DEFAULT true,
    routing_strategy character varying(255),
    series_id uuid NOT NULL,
    CONSTRAINT chapters_pkey PRIMARY KEY (id),
    CONSTRAINT fklni0nmcuoug1owwvftxhess9k FOREIGN KEY (series_id) REFERENCES public.series(id) ON DELETE CASCADE,
    CONSTRAINT uktnbdlppu59akux8v9ns6cqnht UNIQUE (series_id, chapter_number)
);

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
    created_by uuid,
    CONSTRAINT images_pkey PRIMARY KEY (id),
    CONSTRAINT fkp1m9f9rm7xy8nk7a820dvh6c4 FOREIGN KEY (created_by) REFERENCES public.users(id)
);

CREATE TABLE public.pages (
    id uuid NOT NULL,
    page_number integer NOT NULL,
    chapter_id uuid NOT NULL,
    image_id uuid NOT NULL,
    last_edited_at timestamp(6) with time zone,
    last_rendered_at timestamp(6) with time zone,
    CONSTRAINT pages_pkey PRIMARY KEY (id),
    CONSTRAINT fkffjcfkm11uokm4hqkj7congun FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE CASCADE,
    CONSTRAINT fki0j04aiibciea31rbwukp7x3 FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE,
    CONSTRAINT ukrurl6v5n4lkcpgcveglho9kct UNIQUE (chapter_id, page_number)
);

CREATE TABLE public.conversations (
    id uuid NOT NULL,
    scene_type character varying(255) NOT NULL,
    page_id uuid NOT NULL,
    CONSTRAINT conversations_pkey PRIMARY KEY (id),
    CONSTRAINT fka6hou4fwxlrlvitp3rubjjf8c FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE
);

CREATE TABLE public.layers (
    id uuid NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    metadata_json jsonb,
    target_language character varying(255),
    type character varying(255) NOT NULL,
    visible boolean,
    z_order integer NOT NULL,
    page_id uuid NOT NULL,
    CONSTRAINT layers_pkey PRIMARY KEY (id),
    CONSTRAINT fkau8kwbguf2qow98iracihu77n FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE
);

CREATE TABLE public.panels (
    id uuid NOT NULL,
    bbox_h integer NOT NULL,
    bbox_w integer NOT NULL,
    bbox_x integer NOT NULL,
    bbox_y integer NOT NULL,
    grid_col integer,
    grid_row integer,
    reading_order integer NOT NULL,
    image_id uuid NOT NULL,
    CONSTRAINT panels_pkey PRIMARY KEY (id),
    CONSTRAINT fkb3niaaf0w6mihxyi333g41bd6 FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE
);

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
    page_id uuid NOT NULL,
    panel_id uuid,
    CONSTRAINT ocr_regions_pkey PRIMARY KEY (id),
    CONSTRAINT fkk0ts4meid7kfysedx1cafn2vc FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE,
    CONSTRAINT fktpw0jna8ias7s8htrwrtlx3kw FOREIGN KEY (panel_id) REFERENCES public.panels(id)
);

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
    region_id uuid,
    CONSTRAINT layer_elements_pkey PRIMARY KEY (id),
    CONSTRAINT fk7qyvypb91ygmpsr7fdb7uqblm FOREIGN KEY (layer_id) REFERENCES public.layers(id) ON DELETE CASCADE,
    CONSTRAINT fko8nydt1pgfewqm1gm57i78fip FOREIGN KEY (region_id) REFERENCES public.ocr_regions(id)
);

CREATE TABLE public.conversation_regions (
    conversation_id uuid NOT NULL,
    region_id uuid NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT conversation_regions_pkey PRIMARY KEY (conversation_id, region_id)
);

CREATE TABLE public.job_costs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    job_id text,
    image_id uuid NOT NULL,
    provider text,
    model text,
    prompt_tokens integer,
    completion_tokens integer,
    estimated_cost double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_costs_pkey PRIMARY KEY (id)
);

CREATE TABLE public.jobs (
    id character varying(255) NOT NULL,
    attempt integer,
    created_at timestamp(6) with time zone,
    error text,
    image_id uuid,
    page_id uuid,
    max_attempts integer,
    payload text,
    status character varying(255) NOT NULL,
    trace_id character varying(255),
    type character varying(255) NOT NULL,
    updated_at timestamp(6) with time zone,
    CONSTRAINT jobs_pkey PRIMARY KEY (id)
);

CREATE TABLE public.layer_edit_history (
    id uuid NOT NULL,
    edited_at timestamp(6) with time zone NOT NULL,
    new_value_json jsonb,
    previous_value_json jsonb,
    edited_by uuid,
    layer_element_id uuid NOT NULL,
    CONSTRAINT layer_edit_history_pkey PRIMARY KEY (id),
    CONSTRAINT fkrmw18ccw1ycma9r1kj9p1dwov FOREIGN KEY (layer_element_id) REFERENCES public.layer_elements(id) ON DELETE CASCADE,
    CONSTRAINT fks18okmd6rg7202f0rv03v9rgh FOREIGN KEY (edited_by) REFERENCES public.users(id)
);

CREATE TABLE public.system_settings (
    setting_key character varying(255) NOT NULL,
    setting_value character varying(255) NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL,
    CONSTRAINT system_settings_pkey PRIMARY KEY (setting_key)
);

CREATE TABLE public.model_rates (
    model_id character varying(255) NOT NULL,
    provider character varying(255),
    prompt_price double precision,
    completion_price double precision,
    updated_at timestamp with time zone,
    CONSTRAINT model_rates_pkey PRIMARY KEY (model_id)
);
