# Research brief — grouping OCR text fragments into translation units in manga

**How to use this file:** paste everything below the line into a deep-research agent. It is
self-contained — it assumes no access to our repository. Run the five questions as separate
agents if you can; they barely overlap. §"Output" says what to hand back.

Written 2026-08-08, after `region_threshold_validation_2026-08-08.md` and
`region_merge_prior_art_2026-08-08.md`. If those have moved on, update §"What we already know"
before dispatching — an agent that re-derives what we know is wasted.

---

## Context

I maintain an automated manga translation pipeline. One stage takes a page image and produces
**translation units**: regions of the page that will each be sent to a translator as one string,
have their background painted over, and have the translated text typeset back in. Getting the
region boundaries wrong is expensive and not recoverable downstream — two speech balloons fused
into one region means two characters' dialogue arrive at the translator as a single utterance and
get painted over with one flat fill.

The current pipeline:

1. A YOLO segmentation model detects speech balloons and returns polygons.
2. PaddleOCR detects text and returns **line-level fragments** — for vertical Japanese, roughly
   one box per written column.
3. Fragments are assigned to a balloon by mask overlap. Fragments matching no balloon are
   "free-floating" (narration, SFX, captions).
4. Fragments are grouped into regions by a proximity rule: build a graph where two fragments are
   adjacent if the gap between them is below `threshold_ratio × average fragment width`, then
   take **connected components**.

Step 4 is where the trouble is. It is a 1982-grade algorithm: one distance threshold, transitive
closure, no other conditions.

## What we already know — do not re-derive this

Measured on seven manga pages against by-eye ground truth:

- The shipped value (`2.0 × average fragment width`) **under-splits**: balloons drawn touching
  each other get fused. Tightening to `0.35` fixes this on 6 of 7 pages and costs one wrong split
  on the seventh.
- A single balloon whose text has an internal gap slightly larger than the budget gets split in
  two. That is the cost of the tight value.
- The distance yardstick is an **average over all fragments in the call**, so on a page mixing a
  large shout, ordinary dialogue and a small caption, it is wrong for all three.
- A separate bug: the code decides "text is vertical" from the *book's binding direction*
  (right-to-left), which is a different fact from how the text is set. On a horizontally-set
  Japanese page this makes the vertical gap budget as long as an entire line and the whole page
  collapses into two regions.

We have also read:

- **Rigaud, Nguyen & Burie, "Text block segmentation in comic speech bubbles", MANPU@ICPR 2020**
  (doi:10.1007/978-3-030-68780-9_22). Parameter-free: dilate the bounding boxes of connected
  components inside a balloon pixel by pixel, count contours after each iteration, and stop at
  the start of the longest run of a constant count before it collapses. Empirically stops at 2–4×
  the original box size. Evaluated **qualitatively only** — the authors state no public dataset
  annotates multiple text blocks within one bubble, and ask for one.
- **`zyddnys/manga-image-translator`** (`manga_translator/textline_merge/`): distance budget
  `1.5 × max(font size of the two boxes)`, plus an angle-agreement gate (~36°), plus a
  per-page statistical cut (`distance ≤ mean + 2σ`), over a **minimum spanning tree** rather than
  connected components. Orientation by majority vote over the boxes themselves.
- **`dmMaze/comic-text-detector`**: split threshold `2 × font size`, font-size-ratio gate `1.3`,
  angle gate `cos > 0.866` (~30°).
- **Docstrum** (O'Gorman, TPAMI 1993) and the RLSA→RLSO→Voronoi line of document layout analysis,
  where the trend is consistently to *estimate* spacing thresholds from the page rather than
  configure them.

Our working conclusion, which you should try to break: **our small threshold is compensating for
missing structure.** Everyone else uses a looser distance bound with additional agreement gates
and an adaptive cut, so no single constant carries the decision.

## Questions

Ranked. Q1 and Q2 matter most.

### Q1 — Is there a post-2020 successor to Rigaud et al.?

That paper is five years old, is evaluated only qualitatively, and explicitly asks for a dataset
with multi-text-block-per-bubble annotations. Find out what happened next.

- Papers citing it, especially any with quantitative evaluation on this exact sub-problem.
- Any dataset released since that annotates **multiple text blocks inside one speech balloon**
  (as opposed to text lines, or one block per balloon). Manga109 and eBDtheque do not, as of that
  paper. Check Manga109's later releases, COO, DCM, Comics datasets, and any 2021–2026 additions.
- Whether the field has moved to end-to-end learned grouping (relation/graph networks over text
  boxes, DETR-style set prediction, layout transformers) and whether any of it is usable on a
  small corpus without training data. Look specifically for **manga/comic** work; generic document
  layout models trained on scientific papers may not transfer to balloons.
- Whether modern VLMs are being used to do the grouping directly, and whether anyone has
  published a comparison against geometric methods.

### Q2 — Does the "widest plateau" stopping rule work on line-level boxes?

Rigaud dilates the bounding boxes of **character-level connected components**. Our fragments are
already **line-level** — coarser by an order of magnitude, and far fewer per balloon (often 2–6).

- Is there prior work applying a stability/persistence stopping rule to *already-grouped* text
  boxes rather than raw components?
- With only a handful of boxes, does a plateau in the count even appear, or does the count fall
  straight from N to 1? Look for any analysis of how few elements this class of method needs.
- Related framings worth chasing: **MSER** (maximally stable extremal regions) uses the identical
  "longest stable run" idea; also *persistence* in topological data analysis, *scale-space*
  stability, and stability-based model selection for clustering (e.g. choosing k by stability
  rather than by a score). Is any of that applied to text grouping?

### Q3 — How should the distance metric be defined, and are published constants comparable?

We measure the **gap between box edges**, normalised by average fragment width. Others normalise
by font size of the pair. Before we port anyone's constant we need to know whether `1.5` and
`0.35` are even in the same units.

- How do the standard methods define inter-box distance: centroid-to-centroid, edge gap, or
  nearest-point between polygons? Does it change the effective constant materially?
- For vertical CJK text specifically, what is the right proxy for "character size" given a
  line-level box — its width? A quantile of widths? Something estimated from stroke density?
- Is there guidance on normalising by a **local** rather than page-global size estimate, and how
  local is too local (i.e. when does the estimate get too noisy)?

### Q4 — Detecting text orientation per region

We need to replace "the book reads right-to-left, therefore the text is vertical".

- Standard techniques for deciding vertical vs horizontal text set from detected boxes or from
  pixels: projection profiles, box aspect-ratio voting, component-spacing anisotropy, learned
  classifiers.
- How mixed-orientation pages are handled — a manga page can legitimately carry vertical dialogue
  and horizontal captions at once, so a single page-level answer may be wrong.
- Reliability with few boxes, and known failure cases (single-character balloons like 「え!?」,
  square logos, sound effects).

### Q5 — Evaluation without ground truth

Rigaud could only evaluate by eye. So can we, currently. We hand-count balloons on a handful of
pages.

- What metrics exist for comparing a proposed segmentation against a reference segmentation when
  the units are regions, not pixels? Look at over/under-segmentation measures from document
  layout analysis (e.g. the ICDAR page-segmentation competition metrics), and clustering
  comparison measures adapted to spatial data.
- Is there an accepted way to report **asymmetric** cost, where merging two units wrongly is much
  worse than splitting one wrongly? We care far more about false merges than false splits.
- Any published protocol for annotating text blocks within balloons — guidelines, tooling, or
  inter-annotator agreement figures. If we build the dataset the 2020 paper asks for, we should
  build it the way the field would want it.

## Constraints and non-goals

- **CPU-only inference**, roughly 2 cores per job. Anything requiring a GPU at run time is out.
- Any per-request model call has a **hard 60-second wall-clock budget**; over that is a failure
  regardless of quality.
- We have ~40 annotated pages. Methods needing thousands of training examples are out unless a
  pretrained model exists that transfers without fine-tuning.
- Not interested in: better *text detection* (our OCR fragment detection is adequate), balloon
  detection (already have YOLO segmentation), or OCR accuracy itself. **The question is purely
  how to group fragments into units.**
- Japanese vertical text is the primary case. Latin-script comics are secondary.

## Output

For each question:

1. **Direct answer**, up front. If the answer is "no such work exists", say so plainly — that is a
   useful result, and for Q1 it is a plausible one.
2. **Evidence** — full citations with DOI/arXiv/repo links. For code, link the specific file and
   quote the relevant lines with their constants.
3. **Applicability**, judged against the constraints above. State what would have to be true for
   the approach to work on line-level boxes, CPU-only, with 40 pages.
4. **Confidence**, and what you could not verify. Say when you are reasoning from an abstract
   rather than a full text.

Flag anything that **contradicts** our working conclusion in §"What we already know" prominently.
That is the most valuable thing you can return — we would rather be corrected now than after
changing shipped behaviour.

Prefer primary sources: papers and source code over blog posts and summaries. If a paper is
paywalled, say so rather than paraphrasing a secondary description of it.
