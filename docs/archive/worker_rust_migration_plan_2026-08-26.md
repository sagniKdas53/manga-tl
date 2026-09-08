# Worker migration to Rust — plan

**Date:** 2026-08-26 · **Status:** plan, not validated by a prototype
**Related:** `docs/erasure_overhaul_plan_2026-08-26.md`, `docs/ctd_mask_validation_2026-08-26.md`

## Honest framing

This is written from what the erasure reverse-engineering established plus a survey of the worker's
structure. **No Rust prototype has been built and no Rust benchmark has been run in this repo.**
Where a claim is inferred rather than measured, it says so. Treat the staging as the recommendation
and any timing as unvalidated.

## What is being proposed

**Not** a rewrite. `worker/` is 10,591 lines of Python across 9 handlers and 9 services, and most of
it is orchestration, HTTP, LLM calls and queue plumbing — work where Rust buys nothing and costs a
lot. The parts that would benefit are the CPU-bound image stages, which are exactly the parts the
erasure overhaul is about to add.

**Proposal: extract the image pipeline into a Rust service; leave orchestration in Python.**

## Why Rust is on the table

The erasure work established three things pointing this way:

1. **The inpainters already ship as Rust-friendly artifacts.** `frederik-uni/manga-image-translator-rust`
   publishes AOT, MPE and lama_large as **dynamic-shape opset-18 ONNX** — that is what made the
   inpainter measurements possible at all. Those models are consumed identically from Rust `ort` and
   Python `onnxruntime`.
2. **The mask model is now a clean ONNX subgraph too.** The trimmed CTD `images → seg` graph
   (208 nodes, 65.6 MB, dynamic `[1,3,h,w]`) needs no Python-side processing beyond letterbox,
   sigmoid and threshold — all trivial in Rust.
3. **Cost is the binding constraint.** CTD is 128 s/page published, 75.7 s trimmed, on 4 cores;
   the worker is capped at 2.0 CPUs.

Note carefully: **ONNX Runtime does the same work in both languages. Rust does not make inference
faster.** The gain would be in surrounding image manipulation, memory behaviour under the 4 GB cap,
and avoiding per-textline full-frame buffer copies (§11 of the erasure plan — MIT allocates one
full-frame buffer *per textline*, ~280 MB on a dense page).

## The blocker: PaddleOCR

**PaddleOCR has no Rust equivalent, and this is the biggest risk to any migration.**

`model_manager.py` lazily builds `PaddleOCR` readers per language with det/rec pairs resolved by
`ocr_models.py`. Moving that to Rust means reimplementing, correctly:

- DB detection post-processing (probability map → boxes, with the unclip ratio)
- CTC decoding against per-language character dictionaries
- the det/rec routing already encoded in `ocr_models.py`

That is a project on its own, against a correctness bar set by an OCR corpus we already benchmark.
**Recommendation: do not migrate OCR.**

Second blocker: **RQ is a Python-specific job format on Redis.** A Rust worker would have to speak
its serialization or the queue boundary changes. The staging below sidesteps this by keeping RQ
entirely in Python.

## Staging

### Stage 0 — do the erasure work in Python first (prerequisite)

Phases 0–3 of the erasure overhaul land in Python. That is where the design risk is, and Python
iterates faster. Migrating and redesigning at once would confuse which change caused which result.

### Stage 1 — extract the plate builder as a Rust binary

The erasure plate is the ideal first candidate: one input (image + region geometry), one output
(a PNG), no LLM calls, no queue awareness, no database.

- Rust binary reading a job descriptor on stdin, writing the plate to a path.
- Deps: `ort`, `opencv` or `image` + `imageproc`, `serde_json`.
- Python `process_inpaint` shells out and keeps MinIO, caching and queue responsibility.
- Success = identical masks within tolerance on the same corpus pages, plus a wall-clock win that
  justifies the build complexity.

**If Stage 1 does not show a clear win, stop. That is a legitimate outcome.**

### Stage 2 — absorb bubble detection and geometry

`bubble_detector.py` is already ONNX + OpenCV morphology (letterbox, sigmoid, threshold,
`MORPH_CLOSE`, `approxPolyDP`) with no Python-specific dependencies. `bubble_geometry.py` and the
largest-inscribed-rectangle work are pure computational geometry. Both port cleanly and sit on the
same hot path, so co-locating avoids marshalling masks across the process boundary.

### Stage 3 — reconsider, with production data

Candidates: `merge_regions.py`, `fragment_grouping.py`, `panel_detection.py`. Everything touching
LLM providers, rate limiting, RQ or PaddleOCR stays in Python indefinitely.

## What stays in Python permanently

OCR (PaddleOCR); translation, QA, LLM clients, provider config, rate limiting; RQ handling,
`rq_tasks.py`, `main.py`, `concurrency.py`; anything talking to the backend API or MinIO.

## Open questions

1. **Does Stage 1 actually pay?** Unmeasured. Inference cost is identical across languages; the gain
   is in surrounding work whose share of wall-clock has not been profiled. **Profile the Python
   plate builder before writing any Rust** — if inference dominates, the migration buys nothing.
2. **Build and deploy cost.** The worker image needs a Rust toolchain or multi-stage build, and the
   `opencv` Rust bindings are heavyweight. A real ongoing tax.
3. **Licence.** Same GPL-3.0 question flagged in the erasure plan — unresolved, and yours to answer.
4. **Is per-region cropping enough on its own?** If it brings CTD inside budget in Python, the
   performance argument for Rust weakens considerably.

## Recommendation

**Do not start a Rust migration now.** Finish the erasure overhaul in Python, measure the per-region
crop approach, then profile. Stage 1 is worth doing only if profiling shows non-inference work is a
material share of plate-build time. The Rust port's real gift so far has been its **ONNX artifacts
and its corrections to the upstream algorithm**, not its language.
