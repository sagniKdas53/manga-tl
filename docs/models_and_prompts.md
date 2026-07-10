# ML Models & Prompts

## Models

### Local (on-device inference)

| Model | Format | Framework | Purpose |
|-------|--------|-----------|---------|
| **YOLO11n-seg** (`yolo11n_bubble.onnx`) | ONNX | ONNX Runtime (CPU) | Speech bubble segmentation |
| **PP-OCRv6_medium_det** | PaddlePaddle | PaddleOCR (CPU) | Text detection |
| **PP-OCRv6_medium_rec** | PaddlePaddle | PaddleOCR (CPU) | Text recognition |
| **gemma4:e4b** | GGUF | Ollama | Translation fallback (local LLM) |
| **qwen2.5-vl-3b-instruct** | GGUF | Ollama | OCR / QA vision fallback (local VLM) |

### Cloud API (via OpenRouter / provider)

| Model | Type | Purpose |
|-------|------|---------|
| **qwen/qwen3-vl-32b-instruct** | VLM | Primary cloud OCR |
| **deepseek/deepseek-v4-pro** | LLM | Primary translation |
| **deepseek/deepseek-v4-flash** | LLM | QA (text) |
| **google/gemini-3.1-flash-lite** | VLM | QA (vision) |

Each model has a configurable fallback chain via `_MODEL_LIST` env vars. See `worker/config.py` and `.env`.

---

## Prompts & Response Processing

### 1. Cloud VLM OCR (single crop, structured)

**File:** `worker/services/ocr.py:57-63`

```
Respond with a JSON object containing the text shown in this image
and your confidence score. Use the format:
{"text": "<extracted text>", "confidence": <0.0-1.0>}.
If there is no text, use {"text": "", "confidence": 0.0}.
Do not add any explanations or notes outside the JSON.
```

**JSON schema enforced:**

```json
{
  "type": "object",
  "properties": {
    "text": {"type": "string"},
    "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0}
  },
  "required": ["text"]
}
```

**How response is processed:**

- For **OpenAI / OpenRouter**: schema is passed via `response_format` → `json_schema` with `strict: true`. OpenRouter also gets `plugins: ["response-healing"]` for robustness.
- For **Gemini / Anthropic**: schema is enforced via prompt instruction only (these code paths use their native APIs which don't support structured output in the same way).
- Raw response text is extracted, then:
  1. Parsed via `json.loads()`.
  2. `text` and `confidence` fields extracted.
  3. Confidence clamped to `[0.0, 1.0]`.
  4. Returns `(text, confidence)` tuple.
- **Fallback**: If JSON parsing fails, raw text is used with confidence `1.0` (graceful degradation).
- Called from `perform_redo_ocr()` when initial OCR fails — tries cloud models first, then falls back to PaddleOCR.
- Return type `(str, float)` is now consistent with PaddleOCR's return format.

---

### 2. VLM Batch OCR (structured, with JSON schema)

**File:** `worker/handlers/ocr.py:704-707`

**System prompt:**

```
You are an expert manga OCR system. Perform OCR on each of the provided
image crops. The source language is {lang_name}. Return ONLY a valid
JSON object matching the schema.
```

**JSON schema enforcement:**

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {"type": "string"},
          "text": {"type": "string"}
        },
        "required": ["id", "text"]
      }
    }
  },
  "required": ["results"]
}
```

**How response is processed:**

- Schema is passed via `response_format` → `json_schema` (strict mode) for OpenAI/OpenRouter/Anthropic APIs.
- Raw response text is extracted, then:
  1. Stripped of markdown code fences (```json /```).
  2. Parsed via `json.loads()`.
  3. `.get("results", [])` extracts the array.
  4. Each result must have `id` and `text` keys.
- Regions are matched back by `region_{cr_idx}` IDs to their crop positions.
- Crops are sent in chunks of 10, processed concurrently via `ThreadPoolExecutor` (max 1 worker).
- Falls back through model list on failure.

---

### 3. Vision Batch OCR (user prompt, batch crops)

**File:** `worker/services/translation.py:678-682`

```
You are an expert manga OCR system. Perform OCR on each of the provided
image crops. Each crop is labeled with a Region ID header (e.g.,
'Region ID: crop_0'). Extract the text and map it back to the ID exactly
as specified in the JSON schema.
```

**How response is processed:**

- Identical schema and parsing logic as #2 above.
- Used in the translation vision-flow fallback (when translation detects it needs re-OCR on certain regions).
- Crops are interleaved with `Region ID: {id}` text markers in the message array.
- Response is JSON-parsed, mapped by ID back to regions.

---

### 4. Vision Batch OCR (Anthropic fallback system prompt)

**File:** `worker/services/translation.py:711-712`

```
Respond with a valid JSON object matching the requested schema.
```

**How response is processed:** Same as #3 — identical code path, just a shorter system prompt for Anthropic's API format.

---

### 5. Local VLM Single Crop OCR

**File:** `worker/handlers/ocr.py:777-779`

```
Extract the text from this speech bubble.
```

**How response is processed:**

- Sent with a schema via `try_local_vlm_vision()`.
- Response JSON is parsed: `parsed.get("text", "")`.
- If JSON parsing fails, the raw text response is used directly as a fallback.
- Called once per crop (not batched) via `try_local_vlm_vision()`.

---

### 6. Batch Translation (system prompt, JSON mode)

**File:** `worker/services/translation.py:49-62`

```
You are an expert manga translator.
Translate the list of manga text regions into natural English.
These regions appear in reading order. Maintain context, tone, emotion,
and relationships between speakers.

Region type handling:
- "speech": Translate as natural dialogue.
- "narration": Translate as third-person narrative prose.
- "sfx": Transliterate the sound effect AND provide an English equivalent
  in parentheses (e.g. "DOKAA (WHAM)").
- "caption": Translate as editorial/scene-setting text.
- "sign": Translate literally, noting it's environmental text.

If multiple regions share the same conversationGroup, treat them as a
continuous dialogue exchange and ensure coherent flow.

Return ONLY valid JSON format conforming to the requested schema. No
conversational prefix, suffix, or markdown formatting.
```

**How response is processed:**

1. Passed as `system` role (Anthropic) or `{"role": "system"}` message (others).
2. Schema `TRANSLATION_JSON_SCHEMA` is enforced via `response_format` with strict mode.
3. Raw response text is processed by `parse_and_validate_batch()`:
   - Strips code fences.
   - `json.loads()` parses the JSON.
   - `validate_translation_response()` validates each item:
     - Must have `id` (string) and `translation` (string, non-empty).
     - Optionally extracts `translationNotes`, `emotion`, `tone`, `translationScore`.
     - Returns a dict mapping `id → {translatedText, translationNotes, emotion, tone, translationScore}`.
   - Returns `None` if no valid translations found → triggers fallback model/provider.

---

### 7. Single Translation (system prompt, simple mode)

**File:** `worker/services/translation.py:64-74`

```
You are an expert manga translator.

Translate Japanese manga dialogue into natural English.

Rules:
- Keep names unchanged.
- Preserve tone and emotion.
- Do not explain.
- Do not add notes.
- Do not add quotation marks.
- Return only the translated text.
```

**How response is processed:**

1. No JSON schema — plain text response expected.
2. Raw text is cleaned via `clean_translated_text()` (strips boilerplate, quotes).
3. Validated via `is_valid_translation()`:
   - Rejects empty translations.
   - Rejects text containing forbidden substrings (`"translate the following text"`, `"output:"`, `"json"`).
   - Rejects if identical to source (for Japanese text).
   - Rejects pathologically long translations (short source → 20x longer).
   - **CJK leak detection**: if >15% CJK characters remain in English output.
   - **Length ratio check**: if ratio > 10x, reject.
   - **Duplicate word detection**: if unique word ratio < 0.3, reject.
4. Called from `translate_text()` with a multi-tier fallback chain:
   Cloud LLM → Local LLM → DeepL → Google Translate.

---

### 8. Single Text Translation (user prompt)

**File:** `worker/services/translation.py:1007`

```
Translate the following text to natural {tgt_name}, maintaining its tone
and context. Respond ONLY with the translated text. Do not include any
tags, notes, or explanations.

Text: {text}
```

**How response is processed:** Same as #7 — same `clean_translated_text()` + `is_valid_translation()` pipeline. Used by `translate_text()` for single-region translation.

---

### 9. Batch Translation (user prompt)

**File:** `worker/services/translation.py:1278-1327**

```
{context_str}These text regions appear in reading order.
[... full prompt as documented above ...]

Input:
{bubbles_json}
```

**How response is processed:**

1. Same `parse_and_validate_batch()` + `validate_translation_response()` pipeline as #6.
2. `context_str` is built by `build_context_string()` from series metadata, chapter summaries, and previous page dialogue for cross-page coherence.
3. `bubbles_json` includes region data plus `previousTranslation`/`qaFeedback` for QA-failed retries.
4. Falls back through model list → local LLM.
5. Returns `None` if all tiers fail (caller handles fallback to DeepL individually per region).

---

### 10. LLM Text-Only QA

**File:** `worker/handlers/qa.py:142-164` / `666-688`

```
You are an expert bilingual Japanese-to-English manga translator and QA
reviewer.
[... full prompt as documented above ...]

Region Metadata:
{regions_metadata_json}

You MUST return a JSON object containing a "results" key [...]
```

**How response is processed:**

1. Schema `QA_JSON_SCHEMA` enforced via `response_format`.
2. Raw response is:
   - Stripped of code fences.
   - Parsed via `json.loads()`.
   - `.get("results")` extracts the array.
3. Each result validated against schema: `regionId`, `qaStatus` (passed/failed/direct_fix), `qaScore`, `qaFeedback`.
4. If parsing fails → all regions auto-pass with "Auto-passed fallback".
5. For hybrid mode: LLM pass runs first, results are sent to backend via `/qa-hybrid-prepare`, then render is triggered, then VLM pass runs on the rendered output.

---

### 11. VLM Vision QA

**File:** `worker/handlers/qa.py:368-392` / `940-964**

```
You are an expert Japanese-to-English manga translator and typesetting
reviewer. Given the original Japanese manga page (left) and the English
typeset page (right) [...]
```

**How response is processed:**

1. Side-by-side image (original + typeset) is combined into one JPEG at `quality=85`.
2. Sent to VLM with `QA_JSON_SCHEMA` via `try_cloud_ai_vision()`.
3. Same parsing pipeline as #10: strip fences → json.loads → `.get("results")`.
4. Same auto-pass fallback on parse failure.
5. In hybrid mode: this is the second pass after LLM QA + re-render.
6. Results posted to backend callback with cost tracking (tokens + estimated $).

---

### 12. Translation Response Validation Summary

All translation responses go through `is_valid_translation()` which applies:

| Check | Condition | Reason |
|-------|-----------|--------|
| Empty | `not translated` | Model returned nothing |
| Boilerplate | Contains "translate the following text", "text:", "output:", "json" | Model failed to follow instructions |
| Identical to source | `translated == source` for Japanese text | Model didn't translate |
| Pathologically long | Source ≤5 chars, translation >20x longer | Hallucination |
| CJK leak | >15% CJK characters in English output | Original text leaking through |
| Length ratio | Translation >10x source length | Hallucination |
| Excessive repetition | Unique word ratio <30% | Model stuttering/looping |

---

## Suggestions for Improvement

### 1. ✅ Add JSON schema to single-crop Cloud VLM OCR — **DONE**

**Fix applied in** `worker/services/ocr.py:57-63`. The prompt now requests JSON output, a strict `json_schema` is enforced via `response_format` for OpenAI/OpenRouter, and responses are JSON-parsed with graceful fallback to raw text. Confidence is now propagated from the model instead of hardcoded to `1.0`.

### 2. ✅ Add refusal/heuristic validation to OCR responses — **DONE**

**Fix applied in** `worker/services/ocr.py:11-30` and callers.

`OCR_REFUSAL_PATTERNS` list detects common model refusal phrases (`"i cannot"`, `"as an ai"`, `"unable to"`, etc.). The `is_valid_ocr_text()` function checks all OCR results before acceptance:

- Applied in `perform_redo_ocr()` for both cloud VLM and PaddleOCR paths
- Applied in the VLM batch OCR processing in `process_ocr()` in `worker/handlers/ocr.py`
- PaddleOCR results also filter empty-text lines before joining

### 3. ✅ Add confidence field to batch VLM OCR schema — **DONE**

**Fix applied in** `worker/handlers/ocr.py:672-693`. The batch VLM OCR schema now includes an optional `confidence` field (0.0–1.0). Both cloud and local VLM paths extract it from the response. The hardcoded `0.99` for all VLM OCR regions has been replaced with the model-reported confidence (falling back to `0.99` if the model doesn't provide it).

### 4. ✅ Normalize prompt closing style — **DONE**

**Fix applied in** `worker/services/translation.py:1323`. The batch translation user prompt now matches the system prompt's closing instruction: `"Return ONLY valid JSON format conforming to the requested schema. No conversational prefix, suffix, or markdown formatting."` instead of just `"Return ONLY valid JSON."`.

### 5. Add retry with temperature=0 for JSON parse failures

**Not yet implemented.** When JSON parsing fails (e.g., model returns markdown-wrapped JSON), a simple retry with `temperature=0` would likely succeed. This applies to all structured output paths (OCR batch, translation, QA). Implementation would require storing the prompt + schema and re-calling with adjusted parameters.

**Trade-off:** Increases API call volume and latency. Recommendation: implement only if parse failures are observed in production.

### 2. Stricter response validation for OCR paths

**Current:** The cloud OCR response is trusted at face value — `if text and len(text.strip()) > 0: return text.strip(), 1.0`. A model returning `"I cannot process this image"` would be treated as valid OCR text with confidence 1.0.

**Suggested fix:** Apply a lightweight heuristic check similar to `is_valid_translation()`:

- Reject if response contains refusal phrases (`"I cannot"`, `"I'm sorry"`, `"As an AI"`).
- Reject if response is unexpectedly long relative to a typical speech bubble (<200 chars expected).

### 3. Use strict schema for local VLM crops

**Current:** The local VLM path (`worker/handlers/ocr.py:777-779`) passes a schema but only sets `payload["format"] = "json"` for Ollama — no strict schema enforcement. The fallback path (`except Exception`) catches parse errors and uses raw text.

**Suggested fix:** For Ollama, use the newer structured output API if available, or at minimum validate the parsed response has a `text` field before falling back to raw text.

### 4. Add per-region confidence from VLM OCR

**Current:** When VLM OCR is used, every region gets a hardcoded `confidence: 0.99`. The VLM could provide per-region confidence scores if the schema included a `confidence` field, enabling downstream quality filtering.

### 5. Normalize prompt style across all VLM/LLM calls

**Current style inconsistencies:**

- OCR prompts say `"Respond ONLY with the text"` (unstructured) vs `"Return ONLY a valid JSON object matching the schema"` (structured).
- Translation prompts say `"Return ONLY valid JSON"` — consistent.
- QA prompts say `"You MUST return a JSON object"` — consistent.

**Suggestion:** Standardize all structured-output prompts to a consistent closing style, e.g.:

```
Return ONLY a valid JSON object conforming to the requested schema. No conversational prefix, suffix, or markdown formatting.
```

### 6. Consider adding retry with temperature=0 for JSON parse failures

**Current:** When JSON parsing fails, the region is auto-passed or skipped. A simple retry with `temperature=0` (or lower temperature) would likely succeed on the second attempt since JSON schema failures are often due to model creativity.
