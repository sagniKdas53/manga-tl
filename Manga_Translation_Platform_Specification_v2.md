# Manga Translation Platform (Immich-Inspired)

## Product & Technical Architecture Specification v2.0

> **Changelog from v1.0:** Infrastructure sequenced before AI work. Python/Java boundary
> explicitly designed. Schema expanded with auth, series hierarchy, versioning, and spatial
> bbox. Reading order moved after panel detection. Translation context enriched from real
> translation walkthrough. SFX given its own rendering path. Text fitting, undo/redo,
> mobile, and deployment added. Development order resequenced.

---

## Vision

Build an open, self-hostable platform that combines:

- Immich-style gallery experience
- OCR and layout detection
- Context-aware AI translation
- Editable translation layers
- Searchable metadata
- Non-destructive editing
- Multi-language support

The system must treat translations as editable metadata rather than modifying the original image.
The primary target use case is manga and comics, but the architecture should support screenshots,
documents, webtoons, game dialogue, visual novels, and scanned books.

---

## Core Design Principle

Traditional translation systems:

```
Image -> OCR -> Translation -> Burn text into image -> Done
```

This destroys information.

The platform shall instead operate as:

```
Image -> Panel Detection -> OCR -> Layout Analysis -> Context Analysis
      -> Translation -> Translation Layers -> Render View
```

The original image remains untouched. Every stage produces reusable metadata.

---

## System Architecture

```
React + Vite Frontend (TypeScript)
        |
        v
Spring Boot Backend (Java)
        |
   +----+----+----+
   |    |         |
   v    v         v
PostgreSQL  MinIO   Redis
                    |
                    v
         AI Processing Workers  <-- Python microservices
         +--------+--------+--------+--------+
         |        |        |        |        |
         v        v        v        v        v
       Panel     OCR    Layout  Translation  Render
     Detection
```

### Language Boundary

A critical architectural decision absent from v1.0:

The AI processing workers (Panel Detection, OCR, Layout, Translation) are **Python
microservices**. PaddleOCR, MangaOCR, and VLM client libraries are Python-native.
The Spring Boot backend is Java. These runtimes must communicate explicitly.

**Communication pattern:**

```
Spring Boot  -->  Redis Queue  -->  Python Worker
Spring Boot  <--  Webhook/Poll  <--  Python Worker (job complete)
```

Each AI worker is a standalone Python service. Workers consume jobs from Redis queues,
process them, write results to MinIO and PostgreSQL, then signal completion. Spring Boot
never calls Python directly; it enqueues jobs and polls for results.

**Worker deployment:** Each worker runs in its own Docker container. The compose file
(see Phase 0) defines the full service graph.

---

## Phase 0 — Infrastructure Foundation

*Must be completed before all other phases. This is the skeleton everything else attaches to.*

### Goals

- Self-hostable via a single `docker-compose up`
- Core storage and auth working from day one
- Schema designed with full hierarchy before any AI work begins

### Deployment Specification

`docker-compose.yml` must define:

```
services:
  backend        # Spring Boot
  frontend       # React (Nginx)
  db             # PostgreSQL
  redis          # Redis
  minio          # Object storage
  worker-panel   # Python: panel detection
  worker-ocr     # Python: OCR
  worker-layout  # Python: layout analysis
  worker-trans   # Python: translation
  worker-render  # Python: render/export
```

All services connect over a private Docker network. MinIO and PostgreSQL are not
exposed to the host by default. The frontend reverse-proxies to the backend.

### Authentication

User management is required from day one. The schema and API must support multi-user
deployments even if the initial release ships as single-user.

```
users
  id
  email
  password_hash
  display_name
  role              -- admin | translator | viewer
  created_at
```

Sessions via JWT. All API endpoints require authentication except health checks.

### Series Hierarchy

Manga is organized in collections. The schema must reflect this from day one,
not retrofitted later.

```
series
  id
  title
  original_language   -- ja, zh, ko, en ...
  reading_direction   -- rtl | ltr | ttb
  created_by
  created_at

volumes
  id
  series_id
  volume_number
  title

chapters
  id
  volume_id
  chapter_number
  title

pages
  id
  chapter_id
  page_number
  image_id            -- FK to images
```

The `reading_direction` on the series is used by the reading order detection worker
and by the frontend viewer. Individual chapters may override this.

---

## Phase 1 — OCR Foundation

### Goals

Detect text and bounding boxes reliably across languages.

**Input:** `page.jpg`
**Outputs:** `page.ocr.json`, `page.overlay.png`

### Step 1A — Panel Detection (New, Prerequisite)

Reading order cannot be determined without panel structure. Panel detection runs
**before** OCR.

```
Image
  ↓
Panel Segmentation (OpenCV contour / deep learning detector)
  ↓
Panel Regions with grid coordinates
  ↓
OCR per panel
```

Panel schema:

```json
{
  "imageId": "page001",
  "readingDirection": "rtl",
  "panels": [
    {
      "id": "p001",
      "bbox": { "x": 0, "y": 0, "width": 800, "height": 400 },
      "gridRow": 0,
      "gridCol": 1,
      "readingOrder": 1
    }
  ]
}
```

Reading order is assigned to panels first. Bubble reading order within a panel
is then determined independently.

### Step 1B — Reading Direction

Reading direction is inherited from the series `reading_direction` field.

| Value | Convention                                                         |
| ----- | ------------------------------------------------------------------ |
| `rtl` | Japanese manga (right-to-left panels, right-to-left within panels) |
| `ltr` | Western comics (left-to-right)                                     |
| `ttb` | Webtoons / manhwa (top-to-bottom strip)                            |

The reading direction affects both panel ordering and bubble ordering within panels.

### Step 1C — OCR Pipeline

```
Image
  ↓
PaddleOCR          -- bounding box detection
  ↓
Bounding Boxes
  ↓
Language Detection -- per region (Japanese, Chinese, Korean, English ...)
  ↓
MangaOCR           -- Japanese regions
PPOCR              -- Chinese / Korean regions
Tesseract          -- Latin script fallback
  ↓
Text Recognition
```

Mixed-language pages are real. A Chinese scanlation of a Japanese manga will
contain Traditional Chinese dialogue **and** Japanese SFX (e.g., `とか`) that
the scanlator left untranslated. Each region must carry its own detected language.

### Canonical OCR Schema

```json
{
  "imageId": "page001",
  "regions": [
    {
      "id": "r001",
      "panelId": "p001",
      "text": "やばい",
      "detectedLanguage": "ja",
      "bbox": {
        "x": 123,
        "y": 200,
        "width": 80,
        "height": 90
      },
      "rotation": 90,
      "confidence": 0.98,
      "readingOrder": 1
    }
  ]
}
```

**`bbox` storage note:** The `bbox` column in PostgreSQL must be stored as four
integer columns (`bbox_x`, `bbox_y`, `bbox_w`, `bbox_h`) or as PostgreSQL's
native `box` type — not as a JSON blob. Spatial queries (e.g., "find all
regions in the top half of this page") require queryable coordinates.

**`detectedLanguage`** is an explicit required field. Never absent.

Raw OCR output must never be stored directly. All OCR engines must map into
this schema.

### Reading Order Detection

Reading order is assigned in two passes:

1. **Panel order** — determined by panel detection using the series `reading_direction`
2. **Bubble order within panel** — determined heuristically:
   - RTL: rightmost bubble first, then left; top before bottom
   - LTR: leftmost bubble first; top before bottom
   - TTB: topmost bubble first

```json
{
  "panelReadingOrder": 2,
  "bubbleReadingOrder": 1
}
```

### Conversation Detection

Do not translate individual regions. Group them first.

A conversation is a group of bubbles that belong to the same exchange — typically
within one panel, but may span adjacent panels for continuity.

```json
{
  "conversationId": "conv001",
  "panelIds": ["p001"],
  "regions": ["r001", "r002", "r003"],
  "sceneType": "dialogue"
}
```

`sceneType` values: `dialogue`, `monologue`, `narration`, `flashback`, `sfx_cluster`

This is the fundamental translation unit.

---

## Phase 2 — Layout Understanding

### Goals

Transform OCR regions into meaningful semantic structure.

### Region Type Detection

```json
{
  "regionId": "r001",
  "type": "speech",
  "sfxHandling": null
}
```

Possible `type` values:
- `speech` — standard dialogue bubble
- `thought` — thought bubble
- `narration` — rectangular narration box
- `sfx` — sound effect integrated into artwork (special handling required)
- `caption` — panel caption
- `sign` — in-world text (sign, letter, screen)
- `ui` — interface text (game screenshots etc.)

### SFX Special Path

Sound effects (`type: sfx`) require a different rendering path than dialogue.
SFX are typically integrated into the artwork — the text is part of the visual
composition, not contained in a clean bubble. They cannot be handled with
simple text overlay.

```json
{
  "regionId": "r_sfx_01",
  "type": "sfx",
  "sfxHandling": "overlay",
  "sfxEditorialStyle": "localize"
}
```

`sfxHandling` values:
- `overlay` — place translated SFX text near original (default, no inpainting)
- `inpaint` — remove original SFX and replace (future phase)
- `omit` — drop from translation layer

`sfxEditorialStyle` values:
- `localize` — replace with English equivalent (e.g., `とか` → `tok`)
- `preserve` — keep original SFX characters
- `omit` — remove from output

This is configurable per series.

### Speaker Association

Speaker association in v1.0 is **manual only**. Automatic character identification
from manga art is a hard computer vision problem out of scope for initial phases.

The schema supports it:

```json
{
  "speakerId": "char001"
}
```

But it is populated only through manual assignment in the editor, not automated.
Automated speaker association is scoped to a future phase with explicit ML research
requirements.

---

## Phase 3 — Context-Aware Translation Engine

This phase differentiates the platform from OCR translators.

### Fundamental Principle

Translation cache must **not** use source text as key.

This is incorrect:
```json
{ "やばい": "Oh no" }
```

The same phrase may carry completely different meaning and register depending on
speaker, scene, and emotional context. Context is mandatory.

### What Context Actually Requires (Learned from Walkthrough)

A real translation of a manga page requires the following inputs before a VLM
can produce accurate output:

**Structural context:**
- Page image
- OCR regions with reading order
- Conversation groupings with scene type
- Panel positions

**Narrative context:**
- Previous page summary
- Chapter summary
- Character roster with names, nicknames, honorifics, speech patterns

**Editorial context:**
- Target language
- SFX editorial style
- Register preservation instructions (e.g., "preserve formal register for character X")
- Name romanization rules (e.g., 孝介 → Kosuke, not Kosuke or Kouske)

**Example:** On a Valentine's Day page, a VLM that does not know the cultural context
of chocolate-giving in Japanese school settings will produce flat, misleading translations.
The context package must include cultural notes when they affect meaning.

### Chapter Summary Generation

The `chapterSummary` field in v1.0 had no generation mechanism. It must be generated
as follows:

1. After translating the final page of a chapter, a summary generation job is queued
2. The summary worker calls the VLM with all page translations as input
3. Output is stored in:

```json
{
  "chapterId": "ch001",
  "summary": "...",
  "characters": ["char001", "char002"],
  "keyEvents": ["..."],
  "generatedAt": "...",
  "model": "..."
}
```

4. This summary is included in the context package for all pages in the **next** chapter

For the first chapter, `chapterSummary` is null and the VLM is instructed to infer
context from the page alone.

### Intermediate Language Chains

Manga frequently exists in translation chains: Japanese → Chinese → English.
The platform must track source language per region so translators and the VLM
know whether they are working from original source or an intermediate translation.

```json
{
  "sourceLanguage": "zh-TW",
  "presumedOriginalLanguage": "ja",
  "isIntermediateTranslation": true
}
```

When `isIntermediateTranslation` is true, the VLM prompt should note this and
attempt to infer original intent rather than translating literally from the
intermediate.

### Translation Pipeline

**Step 1 — Assemble context package:**

```json
{
  "page": "base64_or_url",
  "sourceLanguage": "zh-TW",
  "targetLanguage": "en",
  "readingDirection": "rtl",
  "conversations": [...],
  "characterRoster": [...],
  "previousPageSummary": "...",
  "chapterSummary": "...",
  "editorialStyle": {
    "sfxHandling": "localize",
    "preserveHonorifics": false,
    "registerNotes": "Character A speaks formally; Character B is casual and teasing"
  }
}
```

**Step 2 — Send to VLM:**

Candidate models:
- GPT-4o / GPT-5o
- Gemini 2.0+
- Qwen-VL
- Future local VLMs

**Step 3 — Request structured output:**

Prompt objectives:
- Understand emotions and scene
- Understand relationships and power dynamics
- Preserve intent, tone, and register
- Preserve jokes and cultural nuance
- Preserve character voice consistency
- Note translation decisions made (idiom substitutions, register choices)

### Translation Output

```json
{
  "conversationId": "conv001",
  "sourceLanguage": "zh-TW",
  "targetLanguage": "en",
  "translations": [
    {
      "regionId": "r001",
      "source": "你到底想幹嘛",
      "translation": "What do you even want?",
      "translationNotes": "Direct confrontation tone preserved"
    }
  ]
}
```

### Translation Decision Documentation

Each translation may carry notes explaining decisions made:

```json
{
  "regionId": "r004",
  "source": "我想要重新向你道一次謝",
  "translation": "I know, but I wanted to thank you again. Properly.",
  "translationNotes": "Split into two sentences. Beat added for natural English pacing. Stubborn/earnest register preserved.",
  "idiomSubstitutions": [],
  "registerPreserved": true
}
```

These notes are visible in the editor and stored permanently. They explain why
a translation is the way it is — essential for collaborative review and correction.

### Translation Metadata

```json
{
  "emotion": "earnest",
  "confidence": 0.91,
  "speaker": "male_lead",
  "tone": "sincere"
}
```

### Cost and Rate Limit Management

Cloud VLMs are expensive. Sending full-page images to GPT for every page of a
multi-volume series is unsustainable without controls.

Required:
- Per-user and per-series monthly token budget (configurable)
- Cost estimate shown to user before translation job is submitted
- Model selection (cheaper models for draft, expensive for final)
- Retry with exponential backoff on rate limit errors
- Circuit breaker: if VLM is unavailable, queue job and retry later

### Error Handling

```
VLM returns malformed JSON
  → Strip markdown fences, attempt parse
  → If still invalid, store raw output, mark translation as "parse_failed"
  → Alert user; allow manual retry

VLM times out
  → Retry up to 3 times with backoff
  → Move to dead letter queue after 3 failures
  → Notify user

OCR confidence below threshold (< 0.5)
  → Flag region as "low_confidence"
  → Highlight in editor for manual review
  → Still attempt translation with warning
```

Dead letter queues are required for all async workers.

---

## Phase 4 — Translation Layer System

### Rule

Translations must never modify original images.

### Layer Model

```json
{
  "layerId": "layer001",
  "type": "translation",
  "targetLanguage": "en",
  "visible": true,
  "zOrder": 2,
  "elements": [
    {
      "regionId": "r001",
      "text": "What do you even want?",
      "isManuallyEdited": false,
      "editedAt": null
    }
  ]
}
```

### Editable Properties

```json
{
  "text": "...",
  "font": "...",
  "size": 20,
  "autoSize": true,
  "maxWidth": 120,
  "maxHeight": 90,
  "wordWrap": true,
  "rotation": 0,
  "x": 100,
  "y": 200,
  "visible": true
}
```

### Text Fitting (New)

Translated text is frequently longer than source text (Japanese → English expansion
is typically 30–60%). The layer engine must handle overflow automatically.

Text fitting priority:
1. Reduce font size to minimum readable (configurable, default 10pt)
2. Enable word wrap within bounding box
3. If still overflowing, flag element with `overflow: true` for manual correction

`autoSize: true` enables automatic size reduction. Always on by default.
Users can disable per element to lock a font size.

### SFX Rendering Path

SFX elements use a different render model than dialogue:

```json
{
  "regionId": "r_sfx_01",
  "type": "sfx",
  "sfxHandling": "overlay",
  "text": "tok",
  "placementHint": "near-original",
  "style": {
    "font": "manga-sfx",
    "size": 24,
    "bold": true,
    "color": "#000000"
  }
}
```

SFX do not use bubble bounding boxes. They are positioned freely near the original.

### Photoshop Analogy

```
Base Image
  OCR Layer        (bounding boxes, confidence, reading order)
  Translation Layer (translated text, editable)
  SFX Layer        (SFX-specific styling)
  Notes Layer      (translator comments)
  Mask Layer       (future: for inpainting)
```

All layers remain independently toggleable and editable.

### Edit History (New)

Every edit to a layer element is stored in `layer_edit_history`:

```
layer_edit_history
  id
  layer_element_id
  previous_value_json
  new_value_json
  edited_by
  edited_at
```

This powers undo/redo in the frontend and provides a full audit trail.

---

## Phase 5 — Storage Architecture

### Object Store

Recommended: **MinIO**

Compatible with: AWS S3, Backblaze B2, Cloudflare R2

MinIO must be integrated from **day one** (Phase 0), not Phase 5. Phase 5 covers
the complete bucket structure and lifecycle policies.

### Bucket Structure

```
originals/          -- original uploads, never modified
ocr/                -- OCR output JSON
panels/             -- panel detection output JSON
layout/             -- layout metadata JSON
translations/       -- translation results JSON
chapters/           -- chapter summary JSON
layers/             -- layer definitions JSON
renders/            -- preview renders and exports
thumbnails/         -- generated thumbnails
```

### Example

```
originals/page001.jpg
ocr/page001.json
panels/page001.json
layout/page001.json
translations/page001.en.json
chapters/ch001.summary.json
layers/page001.json
renders/page001.preview.jpg
thumbnails/page001.thumb.jpg
```

### Lifecycle Policies

Renders and thumbnails may be regenerated on demand. They can be evicted under
storage pressure. Originals and OCR output must never be evicted automatically.

---

## Phase 6 — PostgreSQL Schema

### Users

```
users
  id UUID PK
  email TEXT UNIQUE
  password_hash TEXT
  display_name TEXT
  role TEXT          -- admin | translator | viewer
  created_at TIMESTAMPTZ
```

### Series Hierarchy

```
series
  id UUID PK
  title TEXT
  original_language TEXT
  reading_direction TEXT   -- rtl | ltr | ttb
  created_by UUID FK users
  created_at TIMESTAMPTZ

volumes
  id UUID PK
  series_id UUID FK series
  volume_number INT
  title TEXT

chapters
  id UUID PK
  volume_id UUID FK volumes
  chapter_number INT
  title TEXT
  summary_json JSONB
  summary_generated_at TIMESTAMPTZ

pages
  id UUID PK
  chapter_id UUID FK chapters
  page_number INT
  image_id UUID FK images
```

### Images

```
images
  id UUID PK
  filename TEXT
  width INT
  height INT
  hash TEXT
  storage_path TEXT
  created_by UUID FK users
  created_at TIMESTAMPTZ
```

### Panels

```
panels
  id UUID PK
  image_id UUID FK images
  bbox_x INT
  bbox_y INT
  bbox_w INT
  bbox_h INT
  grid_row INT
  grid_col INT
  reading_order INT
```

### OCR Regions

```
ocr_regions
  id UUID PK
  image_id UUID FK images
  panel_id UUID FK panels
  text TEXT
  detected_language TEXT     -- ISO 639-1: ja, zh-TW, zh-CN, ko, en ...
  confidence FLOAT
  rotation FLOAT
  bbox_x INT                 -- NOT JSON — queryable columns
  bbox_y INT
  bbox_w INT
  bbox_h INT
  panel_reading_order INT
  bubble_reading_order INT
```

### Conversations

```
conversations
  id UUID PK
  image_id UUID FK images
  scene_type TEXT            -- dialogue | monologue | narration | flashback | sfx_cluster

conversation_regions
  conversation_id UUID FK conversations
  region_id UUID FK ocr_regions
  position INT
```

### Translations

```
translations
  id UUID PK
  conversation_id UUID FK conversations
  source_language TEXT
  target_language TEXT
  is_intermediate_translation BOOLEAN
  model TEXT
  version INT                -- increments on retranslation
  is_current BOOLEAN         -- only one per (conversation, target_language) is current
  created_by UUID FK users
  created_at TIMESTAMPTZ

translation_regions
  id UUID PK
  translation_id UUID FK translations
  region_id UUID FK ocr_regions
  source_text TEXT
  translated_text TEXT
  translation_notes TEXT
  emotion TEXT
  tone TEXT
  confidence FLOAT
  is_manually_edited BOOLEAN
  edited_at TIMESTAMPTZ
  edited_by UUID FK users
```

Previous translation versions are retained when retranslation runs.
`is_current = false` versions are archived, not deleted.

### Layers

```
layers
  id UUID PK
  image_id UUID FK images
  type TEXT                  -- translation | ocr | notes | mask | sfx
  target_language TEXT
  visible BOOLEAN
  z_order INT
  created_at TIMESTAMPTZ

layer_elements
  id UUID PK
  layer_id UUID FK layers
  region_id UUID FK ocr_regions
  text TEXT
  font TEXT
  size FLOAT
  auto_size BOOLEAN
  max_width INT
  max_height INT
  word_wrap BOOLEAN
  rotation FLOAT
  x FLOAT
  y FLOAT
  visible BOOLEAN
  overflow BOOLEAN
  is_manually_edited BOOLEAN
  edited_at TIMESTAMPTZ

layer_edit_history
  id UUID PK
  layer_element_id UUID FK layer_elements
  previous_value_json JSONB
  new_value_json JSONB
  edited_by UUID FK users
  edited_at TIMESTAMPTZ
```

### Search Index

```
search_index
  id UUID PK
  image_id UUID FK images
  language TEXT
  content TEXT               -- searchable text
  content_type TEXT          -- ocr | translation | tag
  created_at TIMESTAMPTZ
```

---

## Phase 7 — Spring Boot Backend

### Modules

- `image-service` — upload, storage, thumbnails
- `ocr-service` — job queueing and result retrieval
- `panel-service` — panel detection job management
- `layout-service` — layout classification management
- `translation-service` — context assembly, VLM job dispatch, versioning
- `layer-service` — layer CRUD, edit history
- `search-service` — index management and query
- `render-service` — export job management
- `auth-service` — user management, JWT

### Upload Flow

```
Upload Image
  ↓
Store Original (MinIO)
  ↓
Insert images record
  ↓
Queue: panel-detection
  ↓ (on complete)
Queue: ocr
  ↓ (on complete)
Queue: layout-analysis
  ↓ (on complete)
Auto-queue translation? (user preference)
  ↓
Create default layers
```

### API

```
Auth:
  POST /api/auth/login
  POST /api/auth/register

Series:
  GET  /api/series
  POST /api/series
  GET  /api/series/{id}/chapters

Upload:
  POST /api/images

Processing:
  POST /api/images/{id}/detect-panels
  POST /api/images/{id}/ocr
  POST /api/images/{id}/layout
  POST /api/images/{id}/translate
  GET  /api/images/{id}/jobs         -- job status

Layers:
  GET  /api/images/{id}/layers
  POST /api/images/{id}/layers
  PUT  /api/layers/{id}
  GET  /api/layers/{id}/history      -- edit history

Translation:
  GET  /api/translations/{id}/versions
  POST /api/translations/{id}/retranslate
  PUT  /api/translation-regions/{id} -- manual edit

Search:
  GET  /api/search?q=...&lang=...&series=...

Export:
  POST /api/images/{id}/export
  POST /api/chapters/{id}/export
```

### Async Processing

All AI jobs are async. Never block HTTP.

Workers communicate via Redis queues. Job schema:

```json
{
  "jobId": "...",
  "type": "ocr",
  "imageId": "...",
  "priority": "normal",
  "attempt": 1,
  "maxAttempts": 3,
  "createdAt": "..."
}
```

Dead letter queue: `dlq:{job_type}`. Jobs exceeding `maxAttempts` move here
and trigger a user notification.

### Rate Limiting for VLMs

```
translation_budgets
  user_id
  month
  tokens_used
  tokens_limit
  cost_usd
```

Before dispatching a translation job, check the user's remaining budget.
Estimated cost is shown in the UI before confirmation.

---

## Phase 8 — Frontend

### Technology

- React + Vite + TypeScript
- TanStack Query
- Konva (canvas layer editor)
- Tailwind CSS

### Mobile-First Design

Manga is primarily read on mobile and tablet. The viewer is designed mobile-first.
Touch interactions are first-class:

- Pinch-to-zoom on pages
- Tap bubble to see/edit translation
- Swipe between pages
- Layer panel accessible via bottom sheet on mobile

Desktop builds on mobile affordances — it does not define them.

### Gallery View (Immich-inspired)

```
+----+----+----+
|img |img |img |
+----+----+----+
```

Features: infinite scrolling, fast thumbnails, search, series/chapter navigation,
collections.

### Viewer Modes

- **Original** — source image only
- **OCR** — bounding boxes + detected text + confidence
- **Translation** — translated text overlay
- **Split View** — original left, translated right
- **Bilingual** — both texts visible simultaneously
- **Layer View** — full layer panel with toggles

### OCR Overlay

Shows:
- Bounding boxes colour-coded by confidence
- Detected language tag per region
- Reading order numbers
- Low-confidence regions highlighted for review

### Translation Overlay

Shows:
- Translated text fitted to bounding boxes
- Overflow indicators on regions that need manual sizing
- Speaker association (where assigned)
- Manually-edited regions distinguished visually

### Layer Panel

```
☑ OCR Layer
☑ Translation Layer (EN)
☐ Translation Layer (FR)
☐ Notes Layer
☐ SFX Layer
☐ Mask Layer
```

### Editing Workflow

1. Tap/click a region
2. Edit panel opens:
   - Translation text (editable)
   - Translation notes (read-only — from VLM)
   - Font, size, position, rotation, visibility
   - Override auto-size
3. Changes save instantly to `layer_edit_history`
4. Undo (Ctrl+Z / shake on mobile) reverts to previous `layer_edit_history` entry
5. Redo supported

Undo/redo is scoped per editing session, not global. Clearing session history
on page navigation is acceptable.

### Reading Direction Indicator

The viewer shows the current reading direction and allows override per chapter:

```
← Right to Left (Japanese)   [Change]
```

---

## Phase 9 — Search

### Search Engine

PostgreSQL full-text search is insufficient for multilingual manga at scale.
Recommended: **Meilisearch** (self-hostable, fast, typo-tolerant, supports
CJK tokenization).

Meilisearch runs as an additional Docker service. Spring Boot's `search-service`
indexes content into Meilisearch on write and queries it on search.

### Indexed Content

- OCR text (per region, with language)
- Translated text (per region, per target language)
- Character names and tags
- Chapter and series titles
- Translation notes

### Search Scopes

```
GET /api/search?q=festival&lang=en&series=abc123&scope=translation
```

Scope values: `ocr`, `translation`, `all`

Language filtering ensures CJK text searches hit the right index.

### Example

User searches `festival`:
- Matches English translation regions containing "festival"
- Matches OCR regions containing 祭り (matsuri)
- Future: semantic matches via embeddings

---

## Phase 10 — Rendering Engine

### Export Formats

- PNG
- JPEG
- WEBP
- PDF
- CBZ (translation embedded as metadata, not burned)

### Export Modes

- **Original** — image only, no overlays
- **Translation** — image + translation layer rendered
- **Bilingual** — original text + translation text both shown
- **Layers** — select which layers to include

### CBZ Translation Embedding

Translations are stored in CBZ sidecar metadata (`ComicInfo.xml` extension),
not rendered into page images. This preserves the original art while making
translations accessible to supporting readers.

---

## Future Phases

### Chapter Understanding

Context across pages. Full chapter image sequence used during translation
for long-running narrative coherence.

### Character Memory

Track names, nicknames, honorifics, and speech patterns per character across
the full series. Feed into every translation context package.

### Inpainting

Remove original text. Generate clean bubbles. Place translated text.
Required for SFX `sfxHandling: inpaint` mode and professional typesetting.

### Local AI

Replace cloud VLMs with Qwen-VL or future multimodal models for fully
self-contained deployments without cloud API dependencies.

### PSD Export

Generate layered exports:
- Base Layer
- OCR Layer
- Translation Layer
- Notes Layer

For professional editing workflows.

### Collaborative Translation

Multiple translators working on the same series:
- Assignment system (page ranges per translator)
- Review and approval workflow (`draft` → `review` → `approved`)
- Comment threads on translation regions

---

## Development Order (Revised)

The original order front-loaded AI work before infrastructure existed to support it.
The revised order ensures a working feedback loop at every stage.

```
 1. PostgreSQL schema (full, including auth + series hierarchy)
 2. MinIO integration + object storage service
 3. Spring Boot API skeleton (auth, upload, job queue stubs)
 4. Docker Compose (all services defined, even if workers are stubs)
 5. React viewer (basic: upload + display image)
 6. Panel detection worker
 7. OCR worker (PaddleOCR + MangaOCR + language detection)
 8. OCR overlay in viewer                     ← first meaningful milestone
 9. Reading order detection
10. Conversation grouping
11. Layout analysis worker
12. Translation context assembler
13. VLM translation worker
14. Translation overlay in viewer             ← second milestone: full pipeline visible
15. Layer editor (text editing, font, position)
16. Text fitting (auto-size, overflow detection)
17. Undo/redo
18. SFX rendering path
19. Meilisearch integration + search UI
20. Export engine (PNG, PDF, CBZ)
21. Chapter summary generation
22. Character memory system
23. Inpainting
24. Local model support
```

---

## Success Criteria

A user uploads a manga page. The system:

1. Detects panels and assigns reading order by direction
2. Detects text per panel with language identification
3. Groups dialogue into conversations with scene type
4. Assembles a rich context package including character, chapter, and editorial context
5. Produces context-aware translations with decision notes
6. Creates editable translation layers with text fitting
7. Preserves the original image
8. Allows manual correction with undo/redo
9. Supports future retranslation without rerunning OCR, with version history
10. Handles SFX with configurable editorial style
11. Presents everything through an Immich-like gallery with mobile-first viewer
12. Deployable with a single `docker compose up`
```
