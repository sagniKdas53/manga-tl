-- Initial Schema for Manga Translation Platform

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer', -- admin, translator, viewer
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Series
CREATE TABLE IF NOT EXISTS series (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    original_language TEXT NOT NULL, -- ja, zh, ko, en etc.
    reading_direction TEXT NOT NULL DEFAULT 'rtl', -- rtl, ltr, ttb
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Volumes
CREATE TABLE IF NOT EXISTS volumes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    series_id UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    volume_number INT NOT NULL,
    title TEXT,
    UNIQUE(series_id, volume_number)
);

-- Chapters
CREATE TABLE IF NOT EXISTS chapters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    volume_id UUID REFERENCES volumes(id) ON DELETE SET NULL,
    series_id UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    chapter_number INT NOT NULL,
    title TEXT,
    summary_json JSONB,
    summary_generated_at TIMESTAMPTZ,
    UNIQUE(series_id, chapter_number)
);

-- Images
CREATE TABLE IF NOT EXISTS images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename TEXT NOT NULL,
    width INT,
    height INT,
    hash TEXT,
    storage_path TEXT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pages
CREATE TABLE IF NOT EXISTS pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    page_number INT NOT NULL,
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    UNIQUE(chapter_id, page_number)
);

-- Panels
CREATE TABLE IF NOT EXISTS panels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    bbox_x INT NOT NULL,
    bbox_y INT NOT NULL,
    bbox_w INT NOT NULL,
    bbox_h INT NOT NULL,
    grid_row INT,
    grid_col INT,
    reading_order INT NOT NULL
);

-- OCR Regions
CREATE TABLE IF NOT EXISTS ocr_regions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    panel_id UUID REFERENCES panels(id) ON DELETE SET NULL,
    text TEXT,
    translated_text TEXT,
    approved BOOLEAN DEFAULT FALSE,
    translation_failed BOOLEAN DEFAULT FALSE,
    detected_language TEXT NOT NULL,
    confidence FLOAT,
    rotation FLOAT DEFAULT 0.0,
    bbox_x INT NOT NULL,
    bbox_y INT NOT NULL,
    bbox_w INT NOT NULL,
    bbox_h INT NOT NULL,
    panel_reading_order INT,
    bubble_reading_order INT,
    region_type TEXT DEFAULT 'speech' -- speech, thought, narration, sfx, caption, sign
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    scene_type TEXT NOT NULL DEFAULT 'dialogue' -- dialogue, monologue, narration, flashback, sfx_cluster
);

-- Conversation Regions (Many-to-Many with Order)
CREATE TABLE IF NOT EXISTS conversation_regions (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    region_id UUID NOT NULL REFERENCES ocr_regions(id) ON DELETE CASCADE,
    position INT NOT NULL,
    PRIMARY KEY (conversation_id, region_id)
);

-- Translations
CREATE TABLE IF NOT EXISTS translations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    is_intermediate_translation BOOLEAN DEFAULT FALSE,
    model TEXT,
    version INT NOT NULL DEFAULT 1,
    is_current BOOLEAN DEFAULT TRUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Translation Regions
CREATE TABLE IF NOT EXISTS translation_regions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    translation_id UUID NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
    region_id UUID NOT NULL REFERENCES ocr_regions(id) ON DELETE CASCADE,
    source_text TEXT,
    translated_text TEXT,
    translation_notes TEXT,
    emotion TEXT,
    tone TEXT,
    confidence FLOAT,
    is_manually_edited BOOLEAN DEFAULT FALSE,
    edited_at TIMESTAMPTZ,
    edited_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Layers
CREATE TABLE IF NOT EXISTS layers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- translation, ocr, notes, mask, sfx
    target_language TEXT,
    visible BOOLEAN DEFAULT TRUE,
    z_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Layer Elements
CREATE TABLE IF NOT EXISTS layer_elements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    layer_id UUID NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    region_id UUID REFERENCES ocr_regions(id) ON DELETE SET NULL,
    text TEXT,
    font TEXT,
    size FLOAT,
    auto_size BOOLEAN DEFAULT TRUE,
    max_width INT,
    max_height INT,
    word_wrap BOOLEAN DEFAULT TRUE,
    rotation FLOAT DEFAULT 0.0,
    x FLOAT NOT NULL DEFAULT 0.0,
    y FLOAT NOT NULL DEFAULT 0.0,
    visible BOOLEAN DEFAULT TRUE,
    overflow BOOLEAN DEFAULT FALSE,
    is_manually_edited BOOLEAN DEFAULT FALSE,
    edited_at TIMESTAMPTZ
);

-- Layer Edit History
CREATE TABLE IF NOT EXISTS layer_edit_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    layer_element_id UUID NOT NULL REFERENCES layer_elements(id) ON DELETE CASCADE,
    previous_value_json JSONB,
    new_value_json JSONB,
    edited_by UUID REFERENCES users(id) ON DELETE SET NULL,
    edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Search Index
CREATE TABLE IF NOT EXISTS search_index (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL, -- ocr, translation, tag
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create some default indexes for performance and spatial-like range queries
CREATE INDEX IF NOT EXISTS idx_panels_image ON panels(image_id);
CREATE INDEX IF NOT EXISTS idx_ocr_regions_image ON ocr_regions(image_id);
CREATE INDEX IF NOT EXISTS idx_ocr_regions_bbox ON ocr_regions(bbox_x, bbox_y, bbox_w, bbox_h);
CREATE INDEX IF NOT EXISTS idx_layers_image ON layers(image_id);
CREATE INDEX IF NOT EXISTS idx_layer_elements_layer ON layer_elements(layer_id);
