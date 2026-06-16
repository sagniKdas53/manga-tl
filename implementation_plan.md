# Comprehensive Translation Pipeline Improvement Plan

## Problem Statement

Visual analysis of **11 sample pages** comparing original Japanese, human reference translations, and system auto-translated exports reveals systematic quality gaps across the entire pipeline: OCR → prompt assembly → LLM translation → typesetting. This plan proposes targeted, incremental fixes organized into 6 phases.

---

## Evidence Summary — All 11 Samples

| Sample | Layout Type | Key Failures in System Export |
|--------|------------|-------------------------------|
| **1** | Multi-panel, 2 speakers | OCR fragmentation ("GatherOver at here"), speaker confusion, concatenated words in typesetting |
| **2** | Multi-panel action | Narration box not distinguished from speech; SFX lost |
| **3** | Dense dialogue, comedy | Multiple conversations mixed in flat list; emotional tone lost |
| **4** | 4-panel, single character | Text overlapping bubble edges; some bubbles empty |
| **5** | Wide panels, narration-heavy | Narration translated as dialogue; wrong register |
| **6** | Close-up emotional scene | Tone/register incorrect (formal→casual); partial translation in some bubbles |
| **7** | Dense 3-section, lunch scene | Long flowing Japanese text fragmented into 5+ separate regions; context fully lost across conversation groups. System bubbles are nearly **empty** — most text missing. Top-left dense paragraph completely lost |
| **8** | 3-panel progression (10→100→1000) | Heart-shaped decorative text ("10", "100", "1000") treated as OCR regions. Short emotional phrases truncated. System shows plain "10/100/1000" boxes instead of decorative hearts |
| **9** | Single illustration, 3 bubbles | **Severe text/Japanese mixing** — "Im, your m's が胸 It's hitting n my est..." in system export. Manual typeset version slightly better but still garbled. Human TL is clean |
| **10** | Color manga, dense 2-panel with SFX | Multiple SFX (びえええ, ギチ, ピッ) rendered as regular speech. System mistranslates title box. Character names wrong. Massive text overlap in bottom panel |
| **11** | Single illustration, 3 bubbles | System export shows **raw Japanese mixed with English fragments** — "けど陰キャ...chmaking...ing is a もっと scary." Complete OCR/translation pipeline failure on non-bubble text regions |

---

## Cross-Sample Pattern Analysis

### 🔴 Critical Pattern: OCR Region Fragmentation (Samples 1, 7, 9, 10, 11)

The OCR engine (PP-OCRv5) detects individual text lines. These are **never merged** into logical speech balloons. The result:

- **Sample 7**: A flowing paragraph in the top-left is detected as 6+ line-level regions, each translated independently → complete meaning destruction
- **Sample 9**: 3 bubbles detected as 6+ fragments → Japanese characters leak into "English" translation
- **Sample 10**: Dense SFX + dialogue panels produce 15+ tiny regions → overlapping text chaos
- **Sample 11**: Text outside clear bubble boundaries produces mixed Japanese/English output

**Root cause**: [ocr.py:129-178](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py#L129-L178) appends each OCR detection as a separate region without any merge pass.

### 🔴 Critical Pattern: No Region Type in LLM Prompt (Samples 2, 5, 7, 8, 10)

[classify_region_type](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/layout.py#L30-L100) correctly classifies regions as `speech`/`narration`/`sfx`/`caption`/`sign`, but this information is **never passed to the LLM** in [translate_batch_llm:870-880](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L870-L880).

- **Sample 8**: Heart-shaped decorative numbers (10/100/1000) should be classified as decorative/sign and handled differently
- **Sample 10**: SFX びえええ should be transliterated, not translated as dialogue

### 🟡 Major Pattern: Typesetting Overflow & Formatting (Samples 1, 7, 8, 10, 11)

[fitText.ts](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/utils/fitText.ts) only splits on spaces (line 31). When translated text has no spaces (common for short phrases or concatenated words), it renders as a single overflowing line.

- **Sample 1**: "GatherOver" concatenation
- **Sample 7**: Empty bubbles where text couldn't fit
- **Sample 10**: Overlapping text in dense panels

### 🟡 Major Pattern: Mixed Language Output (Samples 9, 11)

The [is_valid_translation](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L53-L99) validator does **not** check for Japanese/CJK characters leaking into English translations. Both Sample 9 and 11 show exports with mixed Japanese+English text that passed validation.

### 🟢 Minor Pattern: Missing Narrative Context (Samples 3, 5, 6, 7)

The `chapterSummary` and character roster fields exist but are always `null` in practice. Multi-speaker scenes (Sample 7's lunch conversation, Sample 3's comedy dialogue) lose speaker identity because the LLM has no character context.

---

## Proposed Changes

### Phase 1: OCR Region Merging (P0 — Highest Impact)

> [!IMPORTANT]
> This single change addresses the root cause of the worst failures observed across 5 of 11 samples.

#### [NEW] [merge_regions.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/merge_regions.py)

Create a new utility module that merges OCR line-level detections into logical speech balloon groups:

1. **Spatial clustering**: Group OCR regions whose bounding boxes overlap or have a vertical gap ≤ 50% of the average line height
2. **Text concatenation**: Merge text in reading-order within each cluster
3. **Bounding box union**: Use the convex hull / union rect of merged regions as the new bounding box
4. **Confidence aggregation**: Use the minimum confidence across merged regions

```python
def merge_ocr_regions(regions: list, reading_direction: str = "rtl") -> list:
    """Merge OCR line-level detections into logical speech balloon groups.
    
    Args:
        regions: List of OCR region dicts with x, y, width, height, text keys
        reading_direction: 'rtl', 'ltr', or 'ttb'
    
    Returns:
        Merged region list (fewer items, concatenated text, union bounding boxes)
    """
```

#### [MODIFY] [ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py)

Insert a merge pass at line ~179, after region construction and before panel assignment:

```diff
+    from worker.services.merge_regions import merge_ocr_regions
+    regions = merge_ocr_regions(regions, reading_direction)
+
     panel_regions_map = {}
     unmapped_regions = []
```

---

### Phase 2: LLM Prompt Enrichment (P0)

#### [MODIFY] [translation.py — translate_batch_llm](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L870-L880)

Enrich the bubble input with `regionType` and `conversationGroup`:

```diff
  bubbles_input.append({
      "id": r["id"],
      "panel": r.get("panelReadingOrder") or r.get("panelId") or 0,
      "bubble": r.get("bubbleReadingOrder") or 0,
-     "speaker": None,
+     "speaker": r.get("speakerLabel") or None,
+     "regionType": r.get("regionType") or "speech",
+     "conversationGroup": r.get("conversationId") or None,
      "text": r["text"],
  })
```

#### [MODIFY] [translation.py — translate_vlm_vision](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L1042-L1052)

Apply the same enrichment to the VLM bubble input.

#### [MODIFY] [translation.py — MANGA_TRANSLATION_JSON_SYSTEM_PROMPT](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L33-L36)

Enhance the system prompt with region-type-aware instructions:

```
You are an expert manga translator.

Translate the list of manga text regions into natural English.
These regions appear in reading order. Maintain context, tone, emotion, and relationships between speakers.

Region type handling:
- "speech": Translate as natural dialogue. Infer speaker identity from honorifics and context.
- "narration": Translate as third-person narrative prose. Use a more literary register.
- "sfx": Transliterate the sound effect AND provide an English equivalent in parentheses (e.g., "ドカッ" → "DOKAA (WHAM)")
- "caption": Translate as editorial/scene-setting text.
- "sign": Translate literally, noting it's environmental text.

If multiple regions share the same conversationGroup, treat them as a continuous dialogue exchange and ensure coherent flow between them.

Return ONLY valid JSON format conforming to the requested schema.
```

#### [MODIFY] [translation.py — translate_batch_llm prompt](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L886-L918)

Update the user prompt to reference the new fields:

```diff
-These bubbles appear in reading order.
-Translate each bubble into natural manga English.
+These text regions appear in reading order.
+Each region has a "regionType" field indicating its category (speech/narration/sfx/caption/sign).
+Regions with the same "conversationGroup" are part of the same dialogue exchange.
+Translate each region according to its type and maintain conversational coherence within groups.
```

---

### Phase 3: Typesetting Quality (P1)

#### [MODIFY] [fitText.ts](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/utils/fitText.ts)

Add character-level wrapping fallback for words that exceed the available width:

```typescript
// Inside wrapText function, after line 43 (after the word-level wrapping loop)
// Add fallback: if a single word is wider than maxWidth, split at character level
for (let i = 0; i < resultLines.length; i++) {
  const lineWidth = ctx.measureText(resultLines[i]).width;
  if (lineWidth > maxWidth) {
    // Character-level split for this oversized line
    const chars = resultLines[i].split('');
    const subLines: string[] = [];
    let currentSub = '';
    for (const char of chars) {
      const test = currentSub + char;
      if (ctx.measureText(test).width > maxWidth && currentSub) {
        subLines.push(currentSub);
        currentSub = char;
      } else {
        currentSub = test;
      }
    }
    if (currentSub) subLines.push(currentSub);
    resultLines.splice(i, 1, ...subLines);
    i += subLines.length - 1;
  }
}
```

Also reduce the minimum font size floor from 10px to 6px for small bubbles, and add basic hyphenation support:

```diff
-  while (fontSize > 10) {
+  while (fontSize > 6) {
```

---

### Phase 4: Translation Validation Hardening (P1)

#### [MODIFY] [translation.py — is_valid_translation](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L53-L99)

Add three new validation checks after the existing ones:

```python
# 1. CJK leak detection — Japanese/Chinese in "English" translation
if contains_japanese(source_stripped):
    # Source is Japanese, so translation should be English
    import re
    cjk_chars = re.findall(r'[\u3040-\u9FFF\uF900-\uFAFF]', translated_stripped)
    cjk_ratio = len(cjk_chars) / max(len(translated_stripped), 1)
    if cjk_ratio > 0.15:
        logger.warning(
            f"{req_prefix}Validation failed "
            f"reason=cjk_leak "
            f"cjk_ratio={cjk_ratio:.2f} "
            f"source={source} "
            f"translation={translated}"
        )
        return False

# 2. Length ratio check — suspiciously long translations
if len(source_stripped) > 5:
    ratio = len(translated_stripped) / len(source_stripped)
    if ratio > 10:
        logger.warning(
            f"{req_prefix}Validation failed "
            f"reason=length_ratio_exceeded "
            f"ratio={ratio:.1f} "
            f"source={source} "
            f"translation={translated}"
        )
        return False

# 3. Duplicate word detection — "GatherOver GatherOver" style artifacts
words = translated_stripped.split()
if len(words) >= 4:
    unique_ratio = len(set(words)) / len(words)
    if unique_ratio < 0.3:
        logger.warning(
            f"{req_prefix}Validation failed "
            f"reason=excessive_repetition "
            f"unique_ratio={unique_ratio:.2f} "
            f"source={source} "
            f"translation={translated}"
        )
        return False
```

---

### Phase 5: VLM Vision Enhancement (P2)

#### [MODIFY] [translation.py — translate_vlm_vision](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L1054-L1088)

Enhance the VLM prompt to leverage visual context for OCR verification and speaker identification:

```diff
-These OCR regions were extracted from this manga page.
-Use the page image to understand context (characters, expressions, speech bubble placements).
-Translate each bubble into natural manga English.
+These OCR regions were extracted from this manga page using automated OCR.
+
+IMPORTANT — Before translating:
+1. Verify each region's OCR text against the visible text in the image. If the OCR text
+   appears incorrect (garbled, truncated, or mis-recognized), use the text you actually
+   see in the image instead.
+2. For each bubble, identify the speaker based on visual cues (speech bubble tails,
+   character positions, expressions, panel context).
+3. If a region's "regionType" is "sfx", look at the visual style of the text (bold,
+   angular, wavy) to inform your transliteration style.
+
+Translate each region into natural manga English.
```

Also enrich the VLM bubble input with `regionType`:

```diff
  bubbles_input.append({
      "id": r["id"],
      "panel": r.get("panelReadingOrder") or r.get("panelId") or 0,
      "bubble": r.get("bubbleReadingOrder") or 0,
-     "speaker": None,
+     "speaker": r.get("speakerLabel") or None,
+     "regionType": r.get("regionType") or "speech",
      "text": r["text"],
  })
```

---

### Phase 6: Context Pipeline Completion (P3)

> This phase addresses checklist items 12, 13, 21, and 22 — the narrative context assembly.

#### [MODIFY] [translation.py — build_context_string](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L1185-L1214)

Improve the previous page text formatting to preserve dialogue flow:

```diff
  prev_text = image_info.get("previousPageText")
  if prev_text:
-     context_str += f"Previous Page Text/Dialogue Context:\n{prev_text}\n"
+     # Format previous page dialogue with line breaks instead of pipe separators
+     if isinstance(prev_text, str) and "|" in prev_text:
+         lines = [line.strip() for line in prev_text.split("|") if line.strip()]
+         formatted = "\n".join(f"  - {line}" for line in lines)
+         context_str += f"Previous Page Dialogue (in reading order):\n{formatted}\n"
+     else:
+         context_str += f"Previous Page Dialogue:\n{prev_text}\n"
```

---

## Checklist Alignment

| Checklist Item | Status | This Plan |
|----------------|--------|-----------|
| **9. Reading Order Detection** | [/] Partial | Not addressed (separate concern) |
| **12. Translation Context Assembler** | [/] Partial | **Phase 2** (prompt enrichment) + **Phase 6** (context formatting) |
| **13. VLM Translation Worker** | [/] Partial | **Phase 2** (regionType/conversationGroup), **Phase 5** (VLM OCR verify + speaker ID) |
| **16. Text Fitting** | [x] Complete | **Phase 3** (char-level wrapping, lower min font) — quality improvement |
| **18. SFX Rendering Path** | [ ] Todo | **Phase 2** partially addresses (SFX instructions in prompt). Full rendering path is future work |
| **21. Chapter Summary Generation** | [ ] Todo | **Phase 6** prepares the context pipe. Actual summarization is future work |
| **22. Character Memory System** | [ ] Todo | **Phase 2** adds `speakerLabel` field. Full memory system is future work |
| AI Typesetting #1 (Font Selection) | Planned | Not in this plan — separate PR |
| AI Typesetting #2 (Contour Wrapping) | Planned | Not in this plan — separate PR |
| AI Typesetting #3 (VLM Styling) | Planned | **Phase 5** adds groundwork (VLM returns more metadata) |

---

## Open Questions

> [!IMPORTANT]
> **1. OCR Merge Threshold Tuning**: The merge algorithm needs a proximity threshold (proposed: vertical gap ≤ 50% of avg line height). Should we make this configurable via env var, or hardcode a sensible default?

> [!IMPORTANT]
> **2. VLM Default**: Currently VLM vision is opt-in (`USE_VLM_TRANSLATION=false`). Samples 9 and 11 show that the VLM's visual context could completely prevent the mixed-language failures. Should we flip the default to `true` when an API key is configured?

> [!WARNING]
> **3. Minimum Font Size**: Reducing from 10px to 6px will make text readable but very small in some bubbles. Should we cap at 8px instead, or add an "auto-overflow" indicator in the UI when text can't fit?

> [!IMPORTANT]
> **4. Phase Ordering**: I propose implementing in order (Phase 1 → 2 → 3 → 4 → 5 → 6) since Phase 1 (OCR merge) has the single biggest impact. Would you prefer a different ordering or want me to start with a specific phase?

---

## Verification Plan

### Automated Tests

```bash
# Unit tests for merge_regions.py
python -m pytest unified-workers/tests/test_merge_regions.py -v

# Unit tests for enhanced validation
python -m pytest unified-workers/tests/test_translation_validation.py -v
```

### Manual Verification

1. **Re-process all 11 samples** through the updated pipeline and compare exports against human reference translations
2. **Visual diff** of system exports before/after each phase
3. **Regression check**: Ensure samples that were already acceptable (Sample 1 bubble 1, Sample 8 short phrases) don't degrade

### Metrics

- Count of mixed-language outputs (target: 0)
- Count of empty/overflowing bubbles in exports (target: ≤1 per page)
- Character-level BLEU score against human reference translations (track improvement per phase)
