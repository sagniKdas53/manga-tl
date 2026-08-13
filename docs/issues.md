# Issues

> Resolved items move to [archive.md](./archive.md) rather than staying here marked done.
> File new bugs here, not in a separate scratch file.
>
> **Standing: 66 filed, 58 closed, 8 open.** No critical or high-severity items open.

## Open, freeform

### Queue management was very slow (mostly fixed)

50 images used to take ~2 hours. `WORKER_POLL_MS` being accidentally regressed to 30s (should be
2s) caused most of it — fixing that cut a 50-page run from ~2h to ~13min. The remaining slowness
was `MAX_LIGHT_SLOTS=1`: four cheap stages (0.2s–110s each) sharing one slot behind LLM calls.
Raising light slots to 4 addressed the rest — see
[perf_analysis_backend_2026-08-02.md](./perf_analysis_backend_2026-08-02.md).

What's left is genuinely small: the [worker pull model](./worker_pull_model.md) would close the
remaining ~1% (poll-boundary latency) — tracked in [TODO.md](../TODO.md), not worth building for
throughput alone.

### UI felt laggy (mostly fixed, two items aren't fixable in frontend code)

Root cause of most of the reported lag was a permanent CSS animation in the Queue Manager costing
27.8% of a CPU core to render a static list. Removed — down to 1.0%. See
[perf_analysis_frontend_2026-08-02.md](./perf_analysis_frontend_2026-08-02.md).

Two complaints remain, both measured, neither a frontend bug:

- **"Lag when background jobs are running"** — app CPU is 4.9% of a core; 71% of the reported lag
  is the main thread being descheduled by host CPU contention, not computing.
- **"Reader has some lag"** — of 8.80s JS CPU time, our code is 0.7s (8%); the rest is React
  reconciliation and MUI.

### Rendered output doesn't match competitor quality (open, actively being worked)

Tracked in [TODO.md](../TODO.md) under "Render quality gap" — full defect list and plan in
[render_quality_gap_2026-08-05.md](./render_quality_gap_2026-08-05.md).

#### Doing now: the three things that make a page look broken (2026-08-13)

Set from `corpus/sample10` against `corpus/samples/sample10/ref-mangatranslator.ai.jpeg`, and
deliberately *not* from anything typographic. D6 and D7 are fixed and the page still looks wrong,
because none of what is wrong with it is about type. These three are, in order of how much they
fix per hour. **All three are being done in one pass — none is being deferred.**

**R1 — a bubble must be bigger than the text inside it, and nothing checks that.**
`process_ocr` assigns a fragment to whichever YOLO mask it overlaps *most* (`ocr.py:611-626`);
any overlap at all wins, and the winner's geometry is accepted unconditionally. The
`contour_bubble_for_unmatched` fallback path has a containment guard (`ocr.py:366`); the YOLO
path has none. `sample10`'s 待って is dark type with a **white stroke around each glyph** on a
yellow burst — no balloon exists — and YOLO fired on the stroke. We then painted `#fcfaf9` in the
shape of the letters onto the yellow and set "WAIT!" in the sliver. Measured over the 40-page
corpus by pairing each contour with its OCR box: **12 of 239 contours are smaller than their own
text** (impossible for a container), 26 are under 1.2x, 67 under 1.5x; the median is 1.85x.

**R2 — when we cannot match the background we give up, which is the worst of the options.**
`detect_background_color`/`_poly` return `None` on anything not near-flat and the caller skips the
fill (`ocr.py:119-203`), so English lands on top of unerased Japanese: 21 elements across the
corpus, 14 of them with no bubble either. `sample10`'s yellow region is the case — the Japanese is
lettered straight onto a character's shaded blanket, there is no balloon and no flat colour, and
every individual decision we make about it is defensible. mangatranslator.ai does not erase this
better than us; **it does not attempt to erase it at all.** It draws a new flat-yellow balloon over
the blanket and sets the English inside. That is a choice, not a capability, and it is copyable
today. Returning `None` must stop meaning "draw nothing".

**R3 — we typeset sound effects and OCR garbage; the reference leaves them alone.**
`sample10`'s `cu3ぎチ！` (a misread of the artwork's ギチィ) became the sentence **"Deadline
countdown activated!"**, and we painted `#edeafe` onto the desk to hold it. `Wen... yun... yun...`
and `?!` are the same. The reference leaves び ぇぇ ええ and ギチィ untouched. Two parts: the
prompt contradiction that *requires* `"DOKAA (WHAM)"` eleven lines above forbidding `"ERUFU
(ELF!)"` (`services/translation.py:65` vs the NEVER line), and no gate stopping an sfx region from
being typeset at all. Note `regionType` is absent from every element in this run — the layout
classifier did not populate it — so the gate cannot simply read that field and assume it is there.

Verify with `scripts/render_preview.py`; the bar is `corpus/sample10/page-10-rendered.png` against
`corpus/samples/sample10/ref-mangatranslator.ai.jpeg`.

##### Done 2026-08-13 (worker `HEAD`), and what it measured

R1 and R2 replayed over `sample10` with `scripts/cover_fill_probe.py` — which calls the real
`bubble_covers_text` and `cover_fill_for_region`, not copies. Of 29 translation elements: **4 had a
non-containing balloon rejected**, **8 got a covering fill where we previously drew nothing**, and
**0 are left with no fill at all**. All three sample10 defects reach parity with
`ref-mangatranslator.ai`: the burst is yellow with black lettering instead of a white glyph-shaped
slab; the blanket is a flat yellow balloon with the Japanese gone instead of English over
unerased Japanese; the dark panel is a dark balloon with white lettering instead of a white slab
with black-on-white.

Three things were found on the way, each recorded because each was a wrong guess corrected by
measurement:

+ **Sampling the region's dominant colour samples the lettering, not the background.** Unenclosed
  manga text carries a thick white stroke so it reads against artwork, and on the yellow blanket
  that stroke was the most common colour in the box — so R2's first output was a *white* slab, the
  exact defect it exists to remove. The sample is now a band outside the text box
  (`COVER_FILL_RING_FRACTION`), which is background by construction. Yellow `#fddd54`, correct.
+ **A backdrop sampled from artwork can be dark, and text colour is chosen without reference to
  it.** The dark panel came back `#33272d` under the default black lettering. `readable_text_color`
  now overrides below WCAG 3.0 (large-text). It fires only below the floor, so a deliberate
  low-contrast pairing survives and black-on-black does not.
+ **Right colour, wrong shape.** With no mask, the *border* test still samples cleanly (the burst's
  yellow comes back that way), and returning a colour with no polygon left the renderer painting
  the element's own box — which after R1 is the sliver the glyphs occupy, so the source lettering
  still showed around the edges. No mask in now always means a synthesized shape out.

**R3 is implemented and unit-tested but only half of it can fire today** — see R4. Its
low-confidence half works off data the export does not carry, so it is not in the probe numbers
above. This matters: R2 covers a region it cannot read *and cannot skip*, so on this page four of
the eight new fills are over sound effects (`Wen... yun... yun...`, `?!`), which is a slab on the
artwork where we previously drew nothing. **R2 without a working R3 is a regression for sfx.**
Measure over the full corpus before shipping; `COVER_FILL_ENABLED=false` reverts R2 alone.

#### R4 — why nothing is ever classified `sfx` (investigated 2026-08-13)

**The version of R4 filed earlier today was wrong on both counts and is corrected here.**

It claimed `detect_panels` returns 0 panels and that this makes every region a `caption`. Neither
holds. `detect_panels` takes **encoded bytes** and calls `cv2.imdecode` (`panel_detection.py:14`);
it was handed a decoded array from `cv2.imread`, so it bailed at the `img is None` guard. Called
correctly it returns 1 panel, and it can never return an empty list anyway — lines 42-43 fall back
to a single whole-page panel. And the "everything is caption" result came from that same mistake:
`panel=None` is the only way to reach the caption arm. With a whole-page panel, `sample10`
classifies as **13 speech, 3 narration**, which is reasonable.

What *is* true, in order of how much it matters:

**A. `sfx` is unreachable for the regions that are actually sfx.** This is what gates R3, and it is
a detection problem, not a panel problem. `classify_region_type` recognises sfx two ways
(`layout.py:53-56`): kana-only text of 5 characters or fewer, or a box more than 3x taller than
wide holding 6 characters or fewer. Stylised sound effects are exactly what the recogniser
mangles, and a mangled read matches neither rule. On `sample10`, び ぇぇ ええ comes back as `云え`
(kanji, so not kana-only) in a 349x211 box (wider than tall), and ギチィ as `cu3ぎチ！` (Latin
characters, and 2.3x tall, under the 3.0 bar). Both classify as `speech`.

**B. Recogniser confidence cannot be used to catch them either.** R3's second half assumes a
garbled read reports a low score. Re-running PaddleOCR over the page directly says otherwise —
**every fragment scores ≥ 0.908, and the `云え` misread scores 0.956.** The recogniser is
confidently wrong. So `JUNK_REGION_MIN_CONFIDENCE` at 0.55 would never fire here, and raising it
to 0.96 would take most of the dialogue with it. Consistent with the corpus-engine correlation
already on file: these engines agree with each other while being wrong.

**Both halves of R3 are therefore inert on this page, and R2's sfx regression is not mitigated by
anything.** That is the live risk from today's work: four slabs go onto `sample10`'s artwork where
we previously drew nothing. `COVER_FILL_ENABLED=false` reverts R2 alone.

**Glyph size looked like it separated them on this page. Measured over all 40, it does not.**
`sqrt(box_area / character_count)` against page width, 804 fragments, OCR configured to match
`ModelManager.get_paddle_ocr_reader` exactly. The largest fragments on the corpus are *dialogue* —
`いい人ね！` at 0.135, `それなら` at 0.105, `されたい` at 0.091 — and genuine sfx (`ドキ` 0.117,
`ワアル` 0.110, `イメージ` 0.103) interleave with them throughout. Any threshold that catches the
sfx throws away whole lines of dialogue. Closed; do not retry without new evidence.

**The corpus-wide confidence numbers are worth keeping even though the sfx idea failed.** 4.4% of
fragments score under 0.55, and that set is uniformly misread garbage — `M`, `江`, `综`, `1`,
`～ツいいい`, `やっホ`. So R3's junk half has precision without recall: it will not catch a
confidently-wrong sfx, and it does catch the D10 junk-region class.

##### The answer: `reject_sfx` already exists and nothing consumes it (2026-08-13)

**Policy, from Sagnik, asked directly: sound effects are never typeset.** No quality bar. And the
mechanism is the QA VLM rather than a rule, because sfx "are quite complex and vary case by case".

That mechanism was already built. `reject_sfx` has been in `QA_JSON_SCHEMA` and all four QA prompts
from the start — *"If the region is a sound effect (SFX) or gibberish that shouldn't be translated,
set this status (downstream will hide the element)"* — and **nothing downstream consumed it.**
`JobCoordinatorService` handled `direct_fix` and `failed`, wrote the status onto the region, and
never touched the element. Grep for it across the worker, backend and frontend and every hit is the
worker declaring it.

It was not even a theoretical gap. The 2026-08-12 `corpus/withQA/` run has the VLM flagging both of
page-2's sfx with correct reasoning:

> *"The region corresponds to the large Japanese scream sound effect in the panel, not a sign or
> dialogue balloon. It should be removed rather than replaced with the misleading '[Illegible sign]'
> text."*

Those are the two defects filed from that run in §8 of the gap doc — the literal `[Illegible sign]`
printed onto the artwork, and `Mumble mumble...` → `Say your complaints.` invented over a scream.
The reviewer caught both, said hide them, and we typeset them anyway.

**Fixed:** `hideTranslationElements` in `JobCoordinatorService`, wired into both QA callback paths
(hybrid and LLM). Hides rather than deletes — the element carries the geometry and the reviewer's
reasoning, an editor may disagree, and the renderer already skips invisible elements. Restricted to
the latest translation layer on the hybrid path, since older layers are superseded history.

**Caveat that follows from the policy:** a QA-off run has *no* sfx rejection at all. That is what
`corpus/exports/` is, and it is why R2's covering fill puts slabs on artwork there. Benchmark runs
should either enable QA or set `COVER_FILL_ENABLED=false`.

**C. 22 of 40 corpus pages get the whole-page fallback**, i.e. no real panels are found. Cause:
`RETR_EXTERNAL` over "everything not near-white" returns **one contour covering 100% of the page**,
which the `width < w * 0.98` guard then rejects. Art bleeding to the page edge and bubbles
straddling the gutter connect every tier into one blob. On `sample10` there is not one fully-white
row on the page; the widest gutter is ~4px at y≈1511 and only 89% of its pixels clear 240. This
degrades reading order and panel-relative classification rather than breaking them, so it ranks
below A.

Reproduce (note the bytes, and the flag — PaddleOCR segfaults on this host under oneDNN):

```
.venv/bin/python -c "import sys; sys.path.insert(0,'worker/src'); \
  from worker.services.panel_detection import detect_panels; \
  print(detect_panels(open('corpus/samples/sample10/source.jpeg','rb').read()))"

FLAGS_use_mkldnn=0 .venv/bin/python -c "from paddleocr import PaddleOCR; \
  r=PaddleOCR(lang='japan', enable_mkldnn=False).predict('corpus/samples/sample10/source.jpeg')[0]; \
  print(sorted(zip(r['rec_scores'], r['rec_texts']))[:5])"
```

### Move the backend off Java

No real technical blocker, just a preference to not maintain a Spring Boot backend long-term.
[migration.md](./migration.md) has an old plan; treat it as a starting point, not current.

### Do we need a separate worker process?

Narrowly answered for one sub-question: the worker keeps no Postgres state of its own (`jobs`,
`queue_job`, `job_costs` are backend-owned; the worker only touches Redis and one HTTP callback),
so a schema baseline never needed to account for a second schema. The bigger "should this split
exist at all" question is still open.

### Is the test suite actually testing anything, or mostly mocking?

Still open as a general question. Two concrete findings so far:

- The worker suite is heavily mocked: `test_translation_flow_e2e.py`'s "e2e" test has 19 `@patch`
  decorators and 4 assertions, none of which check the actual translated content — see
  `AUDIT-T1` below. [mock_router.md](./mock_router.md) is the fix.
- **A cheaper, more auditable version of this problem: incoherent fixtures.** Twice now, a
  pre-existing test went red under a real fix not because of a regression, but because its fixture
  described an impossible state (e.g. `totalElements: 2` while asserting a second page exists).
  Worth a pass asking of every frontend fixture: "could this state exist in production?"

## AUDIT findings

A full-stack read-through (Java backend, Python worker, TS/TSX frontend, Docker) done 2026-08-01,
filed as `AUDIT-*` with `file:line` anchors. **58 of 66 closed** — see
[archive.md](./archive.md) for the reasoning behind each closed item. Security (`AUDIT-S1`–`S4`,
the fail-open secrets and the SSE token leak) is fully closed; before filing anything new against
`/api/images/*/thumbnail` or `/api/images/*/reader`, note those are public **on purpose** — see
[security_boundary.md](./security_boundary.md).

### Open — Backend

#### `AUDIT-B10` (medium) — `listPages` doesn't validate `?sort=`

`SeriesController.listSeries` and `.listChapters` both allowlist their sort field and fall back to
a safe default on anything unrecognized. `PageController.listPages` (`:746-763`) doesn't — it
passes `@PageableDefault Pageable` straight into the repository, so `?sort=` reaches Spring Data's
query derivation as a caller-controlled property name.

**Needs a live measurement before fixing**: hit the real endpoint with `?sort=bogus` and
`?sort=id,desc` and record what actually comes back — an `@WebMvcTest` with a mocked repository
can't tell you (that's `AUDIT-T3` below), and the expected 500 is unverified.

### Open — Worker

#### `AUDIT-W3` (medium) — cooldowns and lock waits burn a job slot doing nothing

Three places block a worker thread while it's still holding a concurrency slot: a provider
cooldown sleep (`llm_client.py:93-100`, up to 60s), a lock spin-wait (`lock.py:21-26`, up to 600s),
and `try_local_ai`'s per-endpoint timeout (`translation.py:576`, up to 10 min total). With
`MAX_HEAVY_SLOTS=1`, a single provider cooldown stalls all heavy work — light jobs are no longer
affected since `AUDIT-W10` raised light slots to 4.

**Deprioritized by user decision**: fixing this needs real concurrency testing to confirm it
doesn't just relocate the deadlock risk, not a mechanical pass. Last in the queue, alongside
`AUDIT-T1` and `AUDIT-D5`.

### Open — Frontend

#### `AUDIT-F9` (low) — responsive behaviour is never verified

Zero uses of `useMediaQuery`/`theme.breakpoints`; all 43 test files run at one implicit viewport,
and `matchMedia` isn't mocked. The primary device is an Android tablet and nothing checks layout
at that size today. Needs a real-browser (Playwright) viewport smoke test — jsdom doesn't lay out
CSS.

### Open — Docker & Compose

#### `AUDIT-D5` (low) — no memory limits on db, redis, minio, or backend

The worker is capped (2 CPUs / 4g, sized from a measured 2.1 GiB peak). The other five services
aren't. Blocked on getting an equivalent peak measurement — this kernel's cgroup v2 has no
`memory.peak`, so it needs a sampled run under load, not a guess from idle `docker stats` numbers
(idle is not representative and sizing from it risks an OOM-kill under real load).

**Deprioritized by user decision**, same reasoning as `AUDIT-W3` — last in the queue.

### Open — Testing

#### `AUDIT-T1` (unranked) — the "e2e" test isn't one

`worker/tests/test_translation_flow_e2e.py` has 19 `@patch` decorators and 4 assertions, none of
which check translated text, region IDs, layer geometry, or cost — a regression that posted `{}`
to every callback would still pass. Suite-wide: 342 `@patch` across 49 files, 217 tests passing in
6.3s touching no real I/O.

**Deprioritized by user decision** — needs `mock_router.md` built first (a real wire-protocol
double), which is design-and-experimentation work, not a mechanical pass.

#### `AUDIT-Q1` (unranked) — 249 `Objects.requireNonNull` calls that can never fire

Concentrated in `JobCoordinatorService` (61), `PageController` (36), `SeriesController` (30),
`LayerController` (28) — almost all guarding freshly-constructed values, literals, or
already-validated locals. Noise that likely drove `AUDIT-B3`'s NPE→400 mapping. A mechanical pass
to delete the ones that can't fire would remove several hundred lines. Natural to fold in
`AUDIT-Q2`'s inline fully-qualified-class-name cleanup — same controllers, one pass.

#### `AUDIT-T3` (unranked) — one bullet still open: `@WebMvcTest` can't prove a pagination fix

Two of three original findings closed alongside `AUDIT-F10`/`F11`/`F12`. The third: `PageControllerTest`
and `SeriesControllerTest` are `@WebMvcTest` with mocked repositories, which can confirm the
controller's response shape but nothing about how Spring Data actually resolves a `Pageable` or
composes a caller `Sort` with a derived query's `OrderBy`. This is what blocks a real fix for
`AUDIT-B10` — closing it means `@SpringBootTest` + Testcontainers (`PipelineFlowIntegrationTest` is
the working pattern already in the codebase).

### Open — Code quality

#### `AUDIT-Q2` (low) — fully-qualified class names inline instead of imports

`SeriesController`, `PageController`, `ChapterRepository`, `PageRepository` write out full package
paths at every use site instead of importing. Mechanical, low-risk — fold into `AUDIT-Q1`'s sweep.
