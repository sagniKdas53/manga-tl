# Canvas-first render fixes — 2026-09-06

**Status:** planned, not started · **Reference set:** `docs/reference/2026-09-06-torii-comparison/`
(untracked, ~29MB) · **Supersedes the framing in:** `~/Downloads/HANDOFF-render-fitter-bugs.md`

Written for a fresh implementation session. Everything below was verified against the tree or
measured from the reference artifacts; where something is assumed it says so.

---

## 1. Why this exists

A handoff dated 2026-09-05 framed the renderer problems as three text-fitting bugs in the worker's
PIL renderer. Checked against the tree:

| Handoff claim | Verdict |
| :--- | :--- |
| `test_grows_past_the_old_width_over_three_cap_in_a_narrow_tall_box` fails on `main` | **Did not reproduce.** 473 passed, 0 failed. The 48px was its container's font environment. |
| Root cause: rectangular boxes silently take the ellipse branch | **False.** `render.py:649` is `if shape != "elliptical":`, the plain path, ahead of the ellipse branch at `:680`. 36 of 150 sampled box/text combinations diverge between the two shapes, so both are live. |
| `"bro..."` at 48px Comic Neue measures 144.0px | **False.** Comic Neue gives 91.0px. 144.0px is DejaVu Sans at **56**px — the fallback its container was using. |
| `shape="rectangular"` is ignored | **False.** Honoured end to end: `coordinator.rs:2013-2017` writes `"elliptical"` for speech and `"rectangular"` otherwise; the vocabulary matches across SQL, Rust, TS and Python. |
| pyright cannot resolve `cv2` (19 errors) | **Did not reproduce.** `pyrightconfig.json` already sets `venvPath`/`venv`/`extraPaths`; 0 errors. |
| `docs/adr/001-torii-architecture-migration.md` | **Does not exist** on any branch (`git log --all --diff-filter=A -- 'docs/adr/*'` is empty). |

The framing was also aimed at the wrong renderer. Sagnik judges output on the **frontend canvas** —
any page needing a proper pass gets opened in the editor anyway, and the PIL render is rarely looked
at. The artifacts make the gap obvious. Same page (3541×2508), same data:

| | plates painted | dialogue type |
| :--- | :--- | :--- |
| Torii | none flat — tight inpaint, SFX untouched | **129px**, tall column of short lines, pink fill + 14px white stroke |
| our PIL render | 1 flat plate | large — the worker has no size cap |
| **our canvas export** | **3 flat plates, 2 with no text at all** | **tiny — the canvas still caps at `min(h/2, 72)`** |

The worker's renderer is *better than the canvas on the same data*. Three defects account for it,
and none of them are what the handoff described.

---

## 2. The three defects

### 2.1 The canvas kept the D7 size cap

`frontend/src/utils/fitText.ts:483`:

```ts
const maxStartSize = Math.min(Math.floor(maxHeight / 2), 72);
```

The comment above it says *"Dropped the width term, matching the Python fix."* It dropped
`maxWidth / 3` and kept the other two. `render.py:799` is `max_start_size = int(max_height)`.

D7's own write-up (`docs/render_quality_gap_2026-08-05.md:341`) says why both terms had to go: one
line at `h/2` with a 1.2 line-height fills exactly 60% of its box and nothing more, and the
`size_cap` group's median fill was *exactly* 0.60. Removing the cap moved the worker's median fill
0.591 → **0.866** (references sit at 0.70–0.85). The canvas never got that improvement.

`72` is also an absolute constant applied to pages from 832px to 6905px wide.

**Nothing can catch this.** `frontend/src/__tests__/utils/fitText.test.ts:10` mocks `measureText` as
`text.length * 10` — **independent of font size**. Line width never grows with the size, so the width
constraint is constant across the whole search and only the pre-cap binds. The D7 test asserts
`> 48`, passes at exactly the cap (72), and would pass just as well with the cap removed. It is blind
in both directions. This is the `AUDIT-T5` shape: a check that exists and cannot see its own subject.

### 2.2 The canvas paints elements that have no text

`frontend/src/components/Reader.tsx:3624` filters on `!element.visible` and nothing else. The worker
has `if not text: continue`; `frontend/src/utils/maskPaint.ts:60-72` also refuses blank text — so the
*export canvas* path is guarded and the *live SVG overlay* is not.

In `ours-project.json` two of three translation elements are `"text": ""` with
`"isManuallyEdited": true` — cleared by hand, still painting page-scale blobs.

`docs/render_quality_gap_2026-08-05.md:366` filed this under D8 and concluded "the empty-text guard
should go in today either way". It did not.

### 2.3 Synthesized masks are ~20% oversized, blob-shaped, and unreshapeable

`worker/src/worker/handlers/ocr.py:287`, `cover_balloon_polygon`:

```python
pad = max(2, round(min(width, height) * COVER_FILL_PAD_FRACTION))   # 0.18, config.py:398
...
r = max(1.0, min(x2 - x1, y2 - y1) * 0.22)                          # corner radius
for cx, cy, start in (...4 corners...):
    for i in range(corner_steps + 1):                                # corner_steps=6 -> 28 points
```

Two independent problems compound:

- **The pad is 18% of the *shorter* side, applied to all four sides.** For a large region that is a
  fraction of its long text extent spent on every edge. Reproduced exactly:

  | element | OCR region | mask bbox | pad | radius |
  | :--- | :--- | :--- | ---: | ---: |
  | 1 | 1798×2445 | 2161×2508 — the full page height | 324px | 475px |
  | 2 | 408×657 | 481×785 | 73px | 106px |
  | 3 | 903×1359 | 1072×1685 | 162px | 236px |

- **The corner radius is 22% of the shorter side**, so a 481×785 plate is rounded by 106px. That is
  what turns a rectangle into a blob and makes the plate read as far larger than the text it covers.

All three come back as **28 points**. `simplify_mask_polygon` at `MASK_POLYGON_TOLERANCE_PX = 2.0`
cannot help: Douglas–Peucker measures deviation from the *retained chord*, and a 106px arc deviates
~31px from its own chord, so every sample survives. `AUDIT-R7` fixed the tolerance from relative to
absolute; it did not anticipate a radius this large.

This is the same complaint `docs/archive/mask_precision_2026-08-27.md` opens with — *"our current masks are
too big… they even overlap each other"* — which stalled pending Torii screenshots. Those now exist.

---

## 3. What Torii actually does

Read from `compare.torii`. Full detail in the reference README; the load-bearing parts:

- **The wrap and the size are stored data.** `"text": "Isn't\nyour\nasshole\n..."` with literal `\n`,
  `"font": "129px WildWords"`. The fitter ran once; the result is editable. We re-run a fitter in
  both renderers on every draw, which is the only reason they can disagree.
- **`originalText` sits beside it** — which is why Torii can bake breaks into `text` and we cannot
  (ours is the translated string QA's `direct_fix` rewrites).
- **The stroke is the mechanism; the background is the exception.** `addFontBackground` and
  `addFontBorder` are `false` on all 74 objects. `lineWidth ≈ fontSize / 9`.
- **The editor exposes exactly that**: font, B/I, alignment, layout h/v, size slider, line spacing,
  letter spacing, and three colours — Text / Stroke / Box — with Box carrying Fill and Border
  checkboxes. No "fit to area" toggle.
- **It does erase**, but tightly and with real inpainting (`torii-inpainted.jpg`), and it never
  touches SFX. **Translate All** and **Inpaint All** are separate actions.

---

## 4. Environment

```bash
cd worker
../.venv/bin/python -m pytest -q        # baseline: 473 passed   (AGENTS.md:69 still says 315)
../.venv/bin/python -m pyright .        # 0 errors
../.venv/bin/python -m ruff check .

cd frontend
npm test && npm run typecheck           # build runs tsc -b --noEmit (added by AUDIT-T5)
```

**Any font-dependent measurement must run in the worker container.** `fonts-comic-neue` is installed
by `worker/Dockerfile:17` and absent on the laptop, so `load_font` falls back silently to DejaVu Sans
(36% wider) and local numbers do not match production:

```bash
docker run --rm --entrypoint python -v "$PWD:/w" -w /w -e PYTHONPATH=/w/src \
  ghcr.io/sagnikdas53/manga-tl-worker:latest -c "from worker.handlers.render import ..."
```

Worker changes need `detect_changes({repo: "manga-tl-worker"})` — the parent repo's
`detect_changes()` sees the submodule as a pointer and reports 0 changes.

---

## Phase 0 — Correct the tracker

`docs/issues.md` carries `AUDIT-R15/R16/R17`, filed 2026-09-05 against `render.py` on the handoff's
framing. Re-aim them:

- **`AUDIT-R15`** (silent font fallback in `load_font`) — real, but worker-side and lower priority
  than filed. Keep; demote from High.
- **`AUDIT-R16`** (a narrow box is capped by its widest unbreakable token) — the geometry holds, but
  it is only *reachable* once the canvas cap is gone. Re-sequence behind Phase 1.
- **`AUDIT-R17`** (the rejected "shape is ignored" claim) — correct as filed, leave it.
- **Add** the canvas size cap, the empty-text plate and the mask over-expansion as first-class
  entries, with the measurements in §2.

---

## Phase 1 — Stop the canvas destroying pages

Smallest diff, largest visible win, no schema change.

1. **Fix the test mock first** — `frontend/src/__tests__/utils/fitText.test.ts:10`. Replace
   `text.length * 10` with a size-proportional stub (`length × fontSize × k`) and re-derive every
   expectation it invalidates. Until this lands, nothing in this phase is verifiable.
2. `frontend/src/utils/fitText.ts:483` — `Math.min(Math.floor(maxHeight/2), 72)` → `maxHeight`,
   matching `render.py:799`. Correct the comment that claims parity.
3. `frontend/src/components/Reader.tsx:3624` — skip elements whose trimmed text is empty, the rule
   `render.py` and `maskPaint.ts:60-72` already use. **This must cover the backdrop, not only the
   glyphs** — the plate is the damage.

**Verify:** re-export the page and diff against `ours-canvas-export.png` — expect one plate instead
of three, and dialogue type well above 72px.

---

## Phase 2 — Masks that fit the text and can be reshaped

Worker-side geometry only. This is Sagnik's "we are expanding the masks out too much".

1. `worker/src/worker/config.py:398` — `COVER_FILL_PAD_FRACTION = 0.18` keyed to `min(w, h)`. Re-key
   the pad to the estimated glyph height, or clamp it absolutely; a plate wants a margin related to
   the *type*, not to the region's long extent.
2. `worker/src/worker/handlers/ocr.py:302` — cap the corner radius absolutely. 22% of the short side
   is what makes a rectangle read as a blob.
3. Re-check `simplify_mask_polygon` (`worker/src/worker/services/bubble_geometry.py:109`) afterwards.
   With a tight radius the existing 2px tolerance should collapse each corner on its own and drop 28
   points to 4–8 **without touching the simplifier**. Verify rather than assume — `AUDIT-R7` already
   pins both directions (`test_a_rectangle_comes_back_as_a_rectangle`,
   `test_a_balloon_tail_survives_because_it_is_not_jitter`).
4. Measure before/after on the corpus: mask-area ÷ OCR-region-area, and points per polygon.

**Constraint:** a smaller plate exposes more source text at the edges. `halo_stroke_for`
(`render.py:408`) is the existing backstop, and `LOCK-1` already accepts this trade for free text —
*a broken word is ugly and local; text outside its box lands on someone else's panel.*

**Do not** also change region merging here. Torii found 8 objects on this page where we found 3, so
over-merging is real, but it is `AUDIT-R10` and a separate measurement.

---

## Phase 3 — Store the fit, keep live as preview

Fit once, persist the result, let the canvas re-fit live only while an element is being edited and
commit on blur. This dissolves the parity problem rather than managing it: PIL has no
raqm/harfbuzz/fribidi and no glyph fallback (D16, `Pillow 12.3.0`, verified), so the two renderers
can never agree on *metrics* — only on *decisions*. Make the decision once and there is nothing left
to keep in lockstep.

**The complexities, honestly** (this is what to weigh before starting):

1. **Nothing writes a fitted size back today.** `render.py:1273` takes `fit["fontSize"]`, draws with
   it, discards it. The stored `size` is stale — `24`, in an 1818×2465 box. The write-back path is
   new work, and it needs a home: the render callback, or a dedicated fit step.
2. **Do not bake `\n` into `text`.** Torii can because it keeps `originalText`; ours is the
   translated string QA rewrites. Add `fitted_size` + `fitted_lines` and leave `text` the unwrapped
   truth. That needs **`AUDIT-B18`, the schema migration runner, built first** — `init.sql` only runs
   on a fresh volume, so today no column can be added to a live deployment. `sqlx::migrate!` is
   dependency-compatible and `backend-rust/src/db.rs:48` (`build_postgres_url`) was written for it.
3. **Staleness becomes a new failure mode, and it is the `AUDIT-B15` shape.** Any write to text, box
   geometry, font or padding invalidates the stored fit. If invalidation is stamped at *request* time
   rather than completion, an element silently keeps a fit describing older text — exactly how the
   re-render sweeper loses edits today.
4. **The commit boundary must be exhaustive**: drag end, textarea blur, slider release, selection
   change, page navigation, tab close. Any path that skips the commit leaves the canvas showing one
   thing and the artifact keeping another — invisible until export.
5. **QA runs after the fit.** Per `AUDIT-B12` the order is translation → render → qa → render. A
   `direct_fix` must trigger a re-fit before that final render, or the stored breaks describe text
   that no longer exists.
6. **`autoSize` changes meaning** — from "always fit" to "size is derived, refit when stale" versus
   "user pinned this". A boolean whose current semantics are load-bearing in three renderers.
7. **Backfill.** Existing rows have no stored fit, so both renderers keep a live fitter as the
   "no stored fit" fallback. Parity shrinks but does not vanish until every row is backfilled.

Because of (7), Phase 1's canvas fitter fix is not wasted — it *is* the fallback and the live-preview
path.

**Order:** `AUDIT-B18` migration runner → columns → worker write-back → canvas reads stored →
live-preview + commit-on-blur → backfill.

---

## Phase 4 — Editor bullets

- **Per-box padding** (bullets 5, 6). Same `AUDIT-B18` prerequisite as Phase 3. `AUDIT-F16` took
  global `textBoxPaddingPx` / `textBoxSafetyPercent` settings *because* no runner existed; the
  per-element override falls back to the global when null. Both renderers read it through the one
  definition each: `frontend/src/utils/textFitBox.ts` and `text_fit_box` in `render.py`, which are
  pinned to a shared parity table (`test_render_extra.py:330`, `textFitBox.test.ts:23`) — keep that
  table honest.
- **Layers panel shows bubble order** (bullet 3). Already computed and stored as
  `ocr_regions.bubble_reading_order`, exposed as `OcrRegion.readingOrder` (`types.ts:100`), and
  reachable from an element via `LayerElement.region`. *Correction to the original note:* it **is**
  already sent to the LLM — `translation.py:148` puts `readingOrder` in the payload. What is missing
  is only the display. Surface it as the row ordinal and sort by it, in the element list
  `AUDIT-F15` added at `ReaderRightSidebar.tsx:723`.
- **Hover highlights on canvas** (bullet 4). Rows have click-to-select; add
  `onMouseEnter`/`onMouseLeave` driving a `hoveredElementId` the SVG overlay renders as an outline.
  Selection state already flows exactly this way.
- **Empty text objects hidden** (bullet 2) — done in Phase 1.
- **Free-text styling** (bullet 1), the part needing no inpainting. Port `halo_stroke_for` to the
  canvas so the editor shows the halo the export already draws — today the canvas strokes no text at
  all, so free-standing text is *less* readable in the editor than in the artifact. Then expose
  Torii's controls per element: text colour, stroke colour, stroke width, and box fill / box border
  as toggles. `lineWidth ≈ fontSize / 9` is Torii's observed default.

---

## Phase 5 — Inpainting prep and test

Deferred deliberately: no model on hand, and no audit of what it costs the rest of the system. This
phase produces the evidence, not the feature. **Do not start it before Phases 1–2 land** — a better
fill on a page whose masks are 20% oversized measures the wrong thing.

Prior art to read first, in order:

| Doc | Why |
| :--- | :--- |
| `docs/archive/erasure_overhaul_plan_2026-08-26.md` | The plan this continues; §7, §9 Phase 1, §10, §11 |
| `docs/archive/ctd_mask_validation_2026-08-26.md` | The 21-page CTD test — a learned model *does* give glyph-shaped masks on our corpus |
| `docs/archive/erasure_method_history_2026-08-27.md` | What the current method replaced, and why |
| `docs/archive/mask_precision_2026-08-27.md` | Masks-vs-inpainting measured; was waiting on the Torii screenshots that now exist |
| `docs/archive/resume_2026-08-28.md` | Where the thread was dropped |

Work:

1. **Fold the Torii comparison into `archive/mask_precision_2026-08-27.md`.** It has a "Torii screenshots
   still to come" placeholder and `docs/reference/2026-09-06-torii-comparison/` closes it. Torii's
   inpainted base is the reference target: tight to the glyphs, SFX untouched.
2. **Build the measurement harness before choosing a model.** Metrics that already have precedent
   here: flattening % (the 6.85%-vs-1.92% gap in D1), text-left-behind rate, artwork-preserved area,
   and per-page latency. Reuse `corpus/gaps/manga-tl-erasure-eval/scripts/maskprobe.py` and
   `maskprobe.json` from the mask_precision work rather than writing new probes.
3. **Re-test CTD glyph masks against the current tree.** The known failure is that CTD *leaves text
   behind* — quantify what survives now that Phase 2 has shrunk the plates, since the two interact.
4. **Survey candidate inpainters** (LaMa / MI-GAN / AOT-GAN class) against the harness. Record
   latency alongside quality — this runs per region, per page, on a worker already contended for.
5. **Decide the integration point**, and keep Torii's separation: translating must not imply
   inpainting. An explicit action, like Torii's Inpaint All.

**Operational notes.** Benchmark on chrome-box, not the laptop — the laptop's two cores are eaten by
any concurrent export arm and timing runs there are invalid. Long mechanical sweeps should go out as
a written runbook (see `docs/gemini-corpus-regen-runbook.md` for the format) rather than being run
interactively. Verify any delegated run against the artifacts it claims to have produced, not against
its own report: count pages in the state file, not invocations.

**Exit criterion:** a table that says what each candidate costs and buys on our corpus. Not a merge.

---

## Phase 6 — Prompt optimisation and caching tests

Also evidence-first. Two separate ideas that got bundled in the original note.

**6a — Prompt size control.** Now that per-model prompt sizes and costs are known, cap and shape the
request rather than sending whatever accumulates. Entry points: `build_context_string`
(`worker/src/worker/services/translation.py:1074`) builds the previous-page prefix, and the batch
assembly around `:148` is where `readingOrder` and region text are packed. Note `AUDIT-W13` already
made context injection strictly page-ordered — do not undo that ordering while trimming payloads.
Measure token counts and cost per page before and after; `project.json` already carries a
`totalCost` block per page, so there is a ready-made unit of comparison.

**6b — QA caching.** **There is no QA cache today.** `AUDIT-Q3` removed three phantom `cache_key`
sites that were built, logged with a hardcoded `(hit=False)`, and thrown away — including one in
`handlers/qa.py` that fired once per text segment and reported a 0% hit rate on nothing. So this is
greenfield, not a repair. Decide what the key actually is (region text + model + prompt version +
image hash for the VLM path), where it lives (Redis is already a dependency), and what invalidates
it. `_qa_cloud_llm` / `_qa_cloud_vlm` (`handlers/qa.py:199`, `:218`) are the call sites.

**6c — LLM-decided reading order** (bullet 8). *Correction:* reading order is already computed **and
already sent** — `translation.py:148`. So the experiment is not "start sending it"; it is "ask the
model to return its own order, compare against ours, and let QA break ties". Cheap to run as an
offline comparison over the corpus before any pipeline change: for N pages, diff the model's order
against `bubble_reading_order` and count disagreements, then hand the disagreements to QA and see
which was right.

**Exit criterion for 6:** measured token/cost deltas and a QA cache hit-rate from a real run. Ship
nothing on the strength of the idea alone.

---

## Verification

| Phase | How |
| :--- | :--- |
| 1 | `cd frontend && npm test && npm run typecheck`. Re-export the page; diff against `ours-canvas-export.png` — one plate, type > 72px. |
| 2 | `cd worker && ../.venv/bin/python -m pytest -q` (473 baseline). Re-run the page; mask-bbox ÷ region-bbox should fall well below the 1.18–1.24 measured today, polygons to single-digit points. Reshape mode usable by hand. |
| 3 | Migration runner tested against a **populated** volume, not a fresh one — that is the whole point of `AUDIT-B18`. Integration test: edit an element, re-export, size holds; QA `direct_fix` re-fits before the final render. |
| 4 | Component tests in `ReaderRightSidebar.test.tsx` for ordinal display and hover→highlight. |
| 5 | A candidate-comparison table on the corpus. No merge. |
| 6 | Token/cost deltas per page; QA cache hit rate from a real run; reading-order disagreement count. |

Throughout: `detect_changes({repo: "manga-tl-worker"})` for worker changes, and take font-dependent
numbers in the container.

---

## File map

**Canvas / editor**
- `frontend/src/utils/fitText.ts` — the fitter. Cap at `:483`; no hyphenation; `fitsClean` at `:519`
  has no mask check (the worker's `stays_inside_mask` has no port); no `limitedBy`.
- `frontend/src/components/Reader.tsx` — `:3624` element filter, `:3660` the live fit, `:3694+`
  backdrops (all `stroke="none"`), `:2427`/`:2613` the only `ensureFontsLoaded` calls (export paths
  only — the live overlay measures through a detached canvas that never triggers a webfont load).
- `frontend/src/components/ReaderRightSidebar.tsx:723` — the element row list.
- `frontend/src/utils/textFitBox.ts`, `maskPaint.ts` — shared rectangle, mask painting.
- `frontend/src/__tests__/utils/fitText.test.ts:10` — the mock that must be fixed first.

**Worker**
- `src/worker/handlers/render.py` — `load_font:88`, `halo_stroke_for:408`, `fit_text_in_box_py:450`,
  wrap branches `:520`/`:649`/`:680`, size search `:799`, `limitedBy:963`, draw `:1273`.
- `src/worker/handlers/ocr.py:287` — `cover_balloon_polygon`.
- `src/worker/config.py:398` — `COVER_FILL_PAD_FRACTION`; `:314` `YOLO_MASK_EROSION`.
- `src/worker/services/bubble_geometry.py:73,109` — `MASK_POLYGON_TOLERANCE_PX`, simplifier.
- `src/worker/services/translation.py:148,1074` — batch payload, context prefix.
- `src/worker/handlers/qa.py:199,218` — QA LLM/VLM call sites.

**Backend**
- `backend-rust/src/jobs/coordinator.rs:2002` — element INSERT (font hardcoded `'Comic Neue'`);
  `:2013-2017` the shape bind.
- `backend-rust/src/routes/layers.rs`, `models.rs:248`, `database/init.sql:212` — the element schema.
- `backend-rust/src/db.rs:48` — `build_postgres_url`, written for the migration runner.

**Docs**
- `docs/issues.md` — `LOCK-1` (never square a free-text column), `AUDIT-B18`, `AUDIT-B12`,
  `AUDIT-B15`, `AUDIT-R7`, `AUDIT-R10`, `AUDIT-R11`, `AUDIT-T5`.
- `docs/render_quality_gap_2026-08-05.md` — D1, D7 (§ the cap, with corpus numbers), D8, D9, D16.
- `docs/reference/2026-09-06-torii-comparison/` — the artifacts and their measurements.
