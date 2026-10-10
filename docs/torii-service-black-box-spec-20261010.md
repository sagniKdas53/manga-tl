# Torii Image Translator: observed client contract and inspection plan

Date: 2026-10-10. Status: static pass done (no login); live inspection not yet run.

Scope and rule: this is a **behavioural spec** of what the public web client sends and
receives, written for comparison against our own pipeline. The project is GPL-3.0 and the
method stays clean-room, so nothing here is code from Torii's `translate.js`, and none should
be ported from it. We record contracts, field names and observed output, not their code.

## 1. How this was gathered

- `GET https://toriitranslate.com/image` and the three page scripts (`base.js`, `coloris.js`,
  `translate.js`), fetched with no cookies. The scripts are not obfuscated and have no source
  maps.
- A Firefox HAR the owner saved on 2026-10-09 (`toriitranslate.com_Archive [26-10-09 …].har`
  in `~/Downloads`). It is a **page load only**. It holds no translate, inpaint or colorize
  call. It does hold a live Firebase ID token in the `accounts:lookup` body, so treat it as a
  credential: do not commit, share or attach it, and delete it once the live run is done.

## 2. Architecture as visible from the client

| Part | What the client shows |
|---|---|
| Hosting | Static pages behind Cloudflare. No framework, plain scripts. |
| Auth | Firebase Auth (Google provider). The client sends `Authorization: Bearer <Firebase ID token>`. On a rejected session it refreshes the token once and retries. |
| Backend | `https://api.toriitranslate.com`. A separate unproxied host exists for self-hosted (local BYOK) models, to avoid Cloudflare's 100 s limit. |
| Client timeout | 180 s on translate, 60 s on inpaint. |
| User data | Firestore (`users/<uid>`), history cached client-side. |
| Telemetry | `POST /api/reporting` with a constant token shipped in the public JS. Not an API for us: do not call it. |

## 3. Endpoints

All take the Firebase bearer token. Success is signalled by a `success` response header and
JSON body field. A balance is returned in a `credits` response header.

### `POST /api/v2/upload` (translate, and inpaint-only)

Multipart form. Parts:

- `file`: the page image (or a crop of it).
- Every setting below is sent **as a form field** (the client moved them out of headers to
  avoid header-size limits). The server's CORS preflight also whitelists them as headers.

| Field | Values seen |
|---|---|
| `target_lang` | language select value |
| `source_lang` | always `auto` |
| `source_langs_whitelist` | JSON array of base language codes, only when the user set one |
| `translator` | model id (section 4) |
| `reasoning_effort` | `none`, `low`, `medium`, `high` |
| `font` | `noto`, `wildwords`, `heroika`, `shonen`, `badcomic`, `mashanzheng`, `komika`, `bangers`, `edo`, `ridi`, `bushidoo`, `hayah`, `itim`, `mogul`, `kalam`, `hindsiliguri` |
| `text_align` | text alignment choice |
| `min_font_size` | number (string) |
| `stroke_disabled` | `true` / `false` |
| `bubbles_only` | `true` / `false` ("Bubbles Only") |
| `inpaint_only` | `true` / `false` (clean the page, no translation) |
| `inpaint_multiplier` | number (string) |
| `legacy_inpaint` | `false` |
| `custom_prompt` | free text, cut to 1000 characters |
| `context` | previous pages' summary text, or `false` |
| `image_url` | `local` |
| `x-byok-<provider>` | the user's own key, for `openrouter google openai anthropic deepseek xai local` |
| `x-byok-local-url`, `x-byok-local-model` | self-hosted endpoint |

Response JSON: `image` (final page, base64), `inpainted` (clean plate, base64), `text` (list of
text objects the editor opens), `context` (summary for the **next** page), `metadata`.

`metadata` fields the client reads: `ocr_time`, `inpaint_time`, `translation_time`,
`summarization_time`, `render_time`, `colorize_time`, `credits_used`, `attempts[]`,
`total_texts_count`, `filtered_texts_count`, `prompt_tokens`, `completion_tokens`,
`reasoning_tokens`, `total_tokens`, `reasoning`, `fallback_model`, `fallback_reason`.

Worth noting for us:

- The server pipeline is **OCR, inpaint, translate, render** (that is the order of the timing
  fields), and the server also returns the clean plate and the structured text list, so the
  editor can re-typeset without another call.
- `context` is carried page to page and condensed server-side when long.
- `fallback_model` and `fallback_reason` exist, so a model failure falls back rather than failing.
- `attempts[]` suggests retries are recorded per page.
- A **cache** keyed on the image plus settings lives client-side. A cache hit costs nothing.

### `POST /api/inpaint` (manual "inpaint this region")

Multipart: `image`, `mask`, `mode`, `font`, `target_lang`, `stroke_disabled`, optional
`x-byok-google`. Also used for the "highlight text to re-run OCR and translation" mode, with a
bounding box. 60 s timeout. "Out of credits." comes back as plain text.

### `POST /api/colorize`

Multipart: `image`, optional `x-byok-xai`. The client labels the model as
`x-ai/grok-imagine-image`. UI says **25 credits per image**.

### `POST /api/byok/encrypt`

JSON `{key}` returning `{success, encrypted_key}`. The user's own key is encrypted server-side
before being stored.

## 4. Models and cost tiers the client lists

| id | provider | tier | $/M in / out |
|---|---|---|---|
| `gemini-3.1-flash-lite` (default) | google | 1 | 0.25 / 1.50 |
| `gpt-6-luna` | openai | 1 | 0.10 / 0.50 |
| `deepseek-v4-flash` | deepseek | 1 | 0.14 / 0.28 |
| `grok-4.20` | xai | 2 | 1.25 / 2.50 |
| `kimi-k2.5` | openrouter | 2 | 0.50 / 2.50 |
| `gemini-3-flash` | google | 3 | 0.50 / 3.00 |
| `gemini-3.8-flash` | google | 3 | 0.75 / 3.75 |
| `claude-sonnet-5.5` | anthropic | 4 | 2.00 / 10.00 |
| `gpt-6.1-sol` | openai | 4 | 2.00 / 10.00 |
| `claude-opus-5.5` | anthropic | 5 | 4.00 / 20.00 |

Billing is in credits, which depends on the model's tokens. With the user's own key it is a
flat 1 credit per image.

## 5. What is behind the login and cannot be read from the client

- Detection, OCR, the translation prompt, the inpainting model, bubble and ownership logic,
  and the credit price per model. These are server-side, so only black-box input and output can
  be observed.
- The exact shape of the `text` list items (positions, angles, fonts, styles). The client
  consumes them but never declares a schema in one place. The owner's existing `.torii`
  bundles already hold these for 270+ pages (see `torii-bundles-are-machine-references`
  memory), so the live run should be compared against those first.

## 6. Plan for the live inspection (owner's real Firefox profile)

Goal: capture a small, controlled set of real round trips so the unknown parts in section 5 are
filled in with evidence. No credit-heavy or bulk runs.

### 6.1 What the owner prepares

1. Close Firefox, then start it from a terminal with the two flags:
   `firefox --marionette --remote-debugging-port`
   (both are needed: Marionette for WebDriver Classic, the debug port for BiDi). Tabs restore.
2. Open `https://toriitranslate.com/image` and make sure the account is signed in (the
   screenshot shows 1629 credits).
3. Pick **three test pages** and give me their paths: a plain bubble page, a page with
   free-standing text/SFX, and one that is already in the `.torii` corpus so we can compare.
4. Tell me the credit budget for the run. Estimate below is about 10 credits.
5. Add the MCP server (needs the owner's go-ahead, it edits Claude config):
   `claude mcp add firefox-devtools npx @mozilla/firefox-devtools-mcp@latest -- --connect-existing --marionette-port 2828 --tool-preset basic`
   Node 20.19 or newer is required.
6. After the run: **quit Firefox and start it normally again.** Marionette sets
   `navigator.webdriver`, which can trip Cloudflare and Google bot checks.

### 6.2 What I do

| Step | Action | Credits |
|---|---|---|
| 1 | `list_pages`, confirm attach, confirm only the Torii tab is touched. I will not read other tabs. | 0 |
| 2 | Start network capture, upload page A, run Translate with the default model (`gemini-3.1-flash-lite`, 1 tier). `get_network_request` on `/api/v2/upload`, saved to the scratchpad. Read the response `text` list, `metadata`, and the `credits` header. | ~1 |
| 3 | Same page, same settings again. Expect a client cache hit and no network call. Confirms cache behaviour. | 0 |
| 4 | Page B and C with the same model. Check that `context` threads from page to page. | ~2 |
| 5 | Page A with `inpaint_only=true`. Compare `inpainted` with our worker's clean plate. | ~1 |
| 6 | Page A with a tier-3 or tier-4 model, same settings. Read `credits_used`, `attempts`, `reasoning_tokens`. | ~3-4 |
| 7 | One manual inpaint via the editor on a small region. Capture `/api/inpaint` request and response. | ~1 |
| 8 | Export `.torii` for page A and diff its text elements against the `text` list from step 2. | 0 |
| 9 | **Skip colorize** (25 credits) unless the owner asks for it. | 0 |

Rules during the run:

- I do not read, print or save `Authorization` values or the BYOK keys in `localStorage`.
  Captured request and response files are stored with those headers stripped.
- No `evaluate_script` against pages other than the Torii tab, and no reads of cookies or
  storage.
- I stop and ask before any step that would exceed the stated credit budget.
- Saved captures go to the scratchpad. Anything kept in the repo is limited to field names,
  shapes and numeric timings, with no images from other people's manga.

### 6.3 What comes out

1. An updated version of this file with the real `text` item schema, a worked `metadata`
   example per model, and the credits per call.
2. A comparison table: Torii output against our pipeline on the same three pages (clean plate,
   box positions and angles, line breaks, font size, translation text), to answer the question
   "is this a quality gap or only a different style?".
3. A short list of settings or behaviours we do not have (for example `context` threading,
   `fallback_model`, reasoning effort), each marked as worth building or not, with the evidence.

### 6.4 Risks

- **Real profile exposure.** The agent can reach anything the signed-in browser can. Mitigation:
  keep the session short, only the Torii tab, close Firefox afterwards. A dedicated profile is
  the safer alternative if the owner prefers.
- **Account risk.** Automated use of a signed-in account may be against Torii's terms. The run
  is a handful of ordinary uploads on the owner's own account and nothing is bulk-fetched or
  replayed against the API outside the page.
- **Bot detection.** `navigator.webdriver` may trigger a Cloudflare challenge. If it does, stop
  and fall back to the owner driving the page while I only read saved HAR files from DevTools.
