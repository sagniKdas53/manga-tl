# Erasure overhaul: glyph-mask inpainting

**Date:** 2026-08-26
**Inputs:** `corpus/gaps/Japanese/comparison/` (one page, seven pipelines, plus toriitranslate.com's project archive carrying a bare
inpainted plate), clean-room RE of `zyddnys/manga-image-translator` (MIT) and
`frederik-uni/manga-image-translator-rust` (the Rust port).
**On naming:** commercial pipelines we benchmark against are referred to as **toriitranslate.com**,
**B**, **C**, **D** throughout. They are paid products and competitors; there is no reason to put
their names in our repository. Open-source upstreams we are studying (`manga-image-translator`,
BallonsTranslator) are named normally — they are published under a public licence and are the
stated subject of the reverse engineering. The A–D mapping is not recorded in this repo.

**Extends:** [`render_quality_gap_2026-08-05.md`](render_quality_gap_2026-08-05.md) — this is D1
("we erase with a flat colour fill; there is no inpainting anywhere"), now with the upstream
algorithm recovered and the feasibility measured.

---

## 1. Verdict

toriitranslate.com's project archive settles the architecture question. It contains **a fully inpainted raster plate**
(`0_inpainted`) plus text objects carrying `x/y/width/height`, `fillColor`, `strokeColor`,
`angle`+`rotation`, `layout`, `textDir`. **It contains no mask.** Erasure is not a render-time
operation for them; it is a separate stage that produces a clean plate, and typesetting happens on
top of that plate.

We do the opposite: erasure *is* the render, performed per element, as
`draw.polygon(poly, fill=bg_hex)` immediately before `draw.text(...)`. That single choice is the
root of D1, D2, D3, D4 and D5 simultaneously.

**The fix is to separate erasure from typesetting**, exactly as upstream does. That is a bigger
change than "add an inpainter", and it is also a simplification — `maskPolygon` stops having two
jobs.

---

## 2. What toriitranslate.com actually does — measured, not assumed

Because the the reference project archive archive ships both `0_original` and `0_inpainted`, their mask can be recovered
by differencing. (Caveat stated up front: this recovers the **damage footprint**, the pixels they
actually changed. It is a *lower bound* on the mask they fed the inpainter — dilation that lands on
white-inside-a-white-balloon leaves no trace. It is nonetheless the number that matters, because it
is what a reader sees.)

| | coverage of page | connected components | median component |
|---|---|---|---|
| toriitranslate.com, recovered footprint | **2.64 %** | **295** | **215 px** |
| ours, translation-layer mask | 15.69 % | 7 | 62,436 px |

295 components at ~215 px each is **per-glyph**. Seven components at 62 k px each is **per-bubble**.
Rendered as black-on-white, toriitranslate.com's footprint is legible as Japanese text — you can read
「Ｋおじさん気絶させてまうし」in the shape of what they deleted. Ours is the balloon silhouette
*including its outline stroke*, which is D2 confirmed visually.

Our mask covers 99.8 % of toriitranslate.com's footprint, so **our detection is not the problem**. Our
granularity is.

### Cross-checked against mangatranslator.ai

toriitranslate.com is one data point, and it is the only pipeline in the set that ships a bare plate. To confirm
the finding is not a toriitranslate.com quirk, the same page was scored against **mangatranslator.ai**, which
ships only a finished render.

The changed-pixel footprint does *not* discriminate — toriitranslate.com 4.36 %, mangatranslator.ai 4.71 %, ours
4.30 %, and ours even has the *smallest* single blob (0.23 % of page against their 0.58 % / 0.40 %).
That is the white-on-white effect again: on this page our fill is nearly invisible, so any metric
that counts changed pixels flatters us.

The discriminating test is **balloon-outline survival** — sampling the dark ink in a 9-px band
straddling each detected bubble contour (33,567 px on this page) and asking what fraction each
pipeline altered:

| | balloon outline ink destroyed | `flattened` inside bubbles |
|---|---|---|
| toriitranslate.com | **1.2 %** | 10.20 % |
| mangatranslator.ai | **4.9 %** | 12.10 % |
| ours | **21.4 %** | 16.35 % |

**Both references preserve the outline; we destroy a fifth of it.** D2 is confirmed against two
independent pipelines, and the ranking on flattened-inside-bubbles matches. Note also that
mangatranslator.ai is 4× worse than toriitranslate.com on the outline metric — consistent with toriitranslate.com being the
more refined successor rather than a peer.

One nuance worth keeping straight, because it cuts against the headline: on *this* page most of our
over-coverage is white paint on white balloon interior, so it is invisible. Finished-render scores
are close — toriitranslate.com 1.70 % flattened, mangatranslator.ai 2.02 %, ours 2.72 %. The 15.69 % is
**exposure**, not damage: it is the area we take responsibility for and would destroy the moment the
interior is not flat. That is precisely why the gap doc's worst pages hit 16 % flattened while this
one looks nearly fine.

---

## 3. toriitranslate.com descends from manga-image-translator

Two identities, from a single record, that do not happen by chance:

- `rotation` is **bit-exactly** `math.radians(angle)` — the same IEEE-754 double. MIT stores `angle`
  in degrees (`utils/textblock.py:77`) and converts at export (`rendering/gimp_render.py:116`). A
  greenfield canvas app would store radians only; carrying degrees at all only makes sense
  downstream of something that produced degrees.
- `x=779.5, w=173` and `y=281.5, h=335` reconstruct four integers exactly — the signature of
  `TextBlock.center` = `(xyxy[:2]+xyxy[2:])/2` over an `int32` box, serialised by
  `server/to_json.py:103` as `minX/minY/maxX/maxY`.

Supporting: `layout`+`textDir` is MIT's packed `direction` field (`h`/`v`/`hr`/`vr`) decomposed
exactly as `gimp_render.py:17-22` decomposes it; `strokeColor` `#fafbf7` is a *near*-white, which is
what MIT's API path returns because `to_json.py:100` sets `adjust_bg_color = False` and skips the
ΔE<30 snap-to-pure; `lineWidth: 6` = `round(31 × 0.2)` where `0.2` is `TextBlock.default_stroke_width`.

Ancestry is probably **BallonsTranslator or MIT**, not MIT specifically — MIT's `TextBlock` is itself
a refactor of BallonsTranslator's, and the vestigial fields (`shadow_*`, `opacity`, `font_weight`)
are dead in MIT but live in BallonsTranslator, which like toriitranslate.com is an *editor*.

The render layer is definitely reimplemented: `font: "31px WildWords"` is CSS shorthand, `fillColor`
is a hex string, `lineWidth`/`textAlign` are `CanvasRenderingContext2D` property names, and `text`
carries embedded `\n` (MIT never persists broken lines). One behavioural divergence: `angle =
-0.325°` should be exactly `0` under MIT's `if abs(angle) < 3: angle = 0` deadzone, so toriitranslate.com removed
the snap.

**Licence note, flagged not resolved:** MIT is GPL-3.0. This plan deliberately consumes only the
*algorithm description* and the *ONNX weights*, and specifies a from-scratch implementation.

---

## 4. How MIT builds the mask

Order matters: **mask refinement runs after translation**, not after detection
(`manga_translator.py:563-568`, comment: *"Delayed to take advantage of the region filtering done
after ocr and translation"*). Regions dropped by OCR or translation filters are never erased. That
is a free fix for our D10 and we should copy it.

The pipeline, `mask_refinement/text_mask_utils.py::complete_mask`:

1. **Source is a per-pixel text-probability map**, not a polygon. DBNet has two heads: `db`
   `(N,2,H,W)` for polygons and `mask` `(N,1,H/2,W/2)`, already sigmoid-activated (verified
   empirically by the RE agent). The seg head is what supplies mask pixels.
2. Downscale by `scale_factor = clamp((mask.h − img.h/3)/mask.h, 0.5, 1.0)`.
3. Binarize at **`> 0`** — effectively no threshold. Pruning is delegated entirely to step 6.
4. Draw a **1-px black rectangle** on each textline's AABB, severing components that bridge
   neighbouring lines or touch the balloon outline.
5. `connectedComponentsWithStats`, 8-connectivity; drop components with `area <= 9`.
6. **The artwork-rejection heuristic:** assign each component to its best-overlapping textline, then
   **drop it if `area_cc >= area_textline_polygon`**. This is what kills screentone, hair, panel
   borders and every large blob the near-zero threshold let through.
7. **Orphan rescue:** a component with essentially no overlap is kept only if its centroid is within
   `0.5 × unit` of the textline, `unit = max(min(font_size, w, h), 10)`. Recovers dakuten, small
   kana, punctuation.
8. **DenseCRF per textline** — Gaussian `sxy=1, compat=3`; Bilateral `sxy=23, srgb=7, compat=20`;
   `DIAG_KERNEL`, `NO_NORMALIZATION`, **5 iterations**, on a `bilateralFilter(d=17, σ=80, σ=80)`
   image. The tight `srgb=7` with `compat=20` against the Gaussian's `3` is what snaps the blob onto
   actual strokes.
9. **Size-scaled dilation:** `dilate_size = max((int((text_size + dilation_offset) * 0.3)//2)*2+1, 3)`,
   `MORPH_ELLIPSE`, 1 iteration, `dilation_offset` default **20**.
10. Global `MORPH_ELLIPSE(kernel_size=3)` dilation; upscale; re-binarize `> 0` (a free ~1 px grow).

**There is no balloon filling anywhere in the mask path.** The mask is strictly glyph-shaped. MIT
*has* a balloon extractor (`rendering/ballon_extractor.py`) but it is used only to fit *translated*
text, never to erase.

The Rust port reproduces this line-for-line with the same constants, and fixes four real defects
(pad-instead-of-stretch, saturating `f32→u8` instead of numpy's wraparound, a working
`complete_mask_fill`, explicit unmatched-textline handling). It adds furigana mask expansion.

---

## 5. How MIT inpaints

| backend | weights | notes |
|---|---|---|
| `default` | AOT-GAN, 22.8 MB | 10 AOT blocks @128 ch, dilations `[2,4,8,16]`, gated weight-standardised convs |
| `lama_mpe` | 108.6 MB | FFC ResNet, 9 blocks, + ZITS masked positional encoding |
| `lama_large` | 204.5 MB | FFC ResNet, **18** blocks, no MPE. MIT's default |
| `sd` | ~2 GB | SD1.5 inpaint UNet, DDIM 50 steps, CFG 7, prompt from a booru tagger |

Mechanics: `inpainting_size` default **2048**; if the long side exceeds it the **whole image** is
resized — **there is no tiling, patching or blending anywhere**. Align to a multiple of 8. The hole
is **zeroed before the net sees it**. Composite is a **hard binary paste** at threshold 127 —
`ans = inpainted*mask + original*(1−mask)` — no feathering, so unmasked pixels are bit-exact.
`bf16` autocast is CUDA-only; CPU is fp32. `fp16` is silently coerced to `bf16` (LaMa darkens in fp16).

**The Rust port is the practical gift here.** It publishes all three as dynamic-shape opset-18 ONNX
as GitHub release assets, and documents the `torch.onnx.export` invocation (including the
`FourierUnitJIT` substitution needed to make LaMa exportable at all) in the release bodies. No
ONNX exists in the Python repo.

```
https://github.com/frederik-uni/manga-image-translator-rust/releases/download/lama_aot/model.onnx
  c5965aca4e5ffa8269051dca1fc30e379d2bded46e0a55366e299ade47086cfc   23.07 MB   ← verified locally
https://github.com/frederik-uni/manga-image-translator-rust/releases/download/lama_mpe/model.onnx
  4c372fdbb974d9b6ccce7a91eaa3aef65c68bf2178e9671a50f65b6eae590a66  110.14 MB
https://github.com/frederik-uni/manga-image-translator-rust/releases/download/lama_large_512px/model.onnx
  107c8306ac1d27c83638d6535846986542dfe2707f1498b1ac9be25b4a963864  207.48 MB
```

Signatures: `image f32[B,3,H,W]`, `mask f32[B,1,H,W]` → `inpainted f32[B,3,H,W]`; `lama_mpe`
additionally needs `rel_pos i64[B,H,W]` and `direct i64[B,H,W,4]`. **None of the three composite
internally** — the caller must cut out.

The upstream repo publishes no digests (`hash: "###"` disables verification). The digest above is
one I computed on a fresh download and it matches the RE agent's independent computation. **Pin it**,
the way `bubble_detector.py` already pins `YOLO_PINNED_CHECKSUM`.

### The measured pre/post contract

Two RE reports disagreed on AOT's normalization — the Python source says `[-1,1]`, the Rust port uses
`[0,1]` for all three. I settled it by running all four combinations and scoring against toriitranslate.com's own
plate inside toriitranslate.com's own mask:

| normalization | hole zeroed | PSNR vs toriitranslate.com | MAE |
|---|---|---|---|
| `[-1,1]` | **yes** | **35.44 dB** | 2.7 |
| `[0,1]` | yes | 34.64 dB | 2.4 |
| `[-1,1]` | no | 18.34 dB | 12.5 |
| `[0,1]` | no | 9.08 dB | 64.6 |

**Zeroing the hole is what matters; the normalization is worth 0.8 dB.** Both reports are right about
the thing that counts. Use `[-1,1]` for AOT (matches the Python source, which is authoritative for
what the checkpoint was trained on) and `[0,1]` for the LaMa variants.

Also measured: LaMa's FFT bottleneck needs alignment to a **multiple of 32**, not 8 — at 8 the
rFFT round-trip fails outright with a broadcast error at `convg2g`. Upstream never hits this because
it resizes rather than pads.

---

## 6. What we do now, and why it fails

`bubble_detector.py` runs YOLO11n-seg, takes the **un-eroded** contour of the cleaned mask
(`epsilon = 0.002 × arcLength`), and stores it as `maskPolygon`. `ocr.py::cover_fill_for_region`
picks a flat colour, or synthesises a covering balloon when the region is not flat. `render.py`
fills that polygon and draws text into it.

Three structural failures, all downstream of one choice:

1. **The unit of erasure is the region.** Every upstream error — an over-merged component, a bad
   polygon, a misdetected watermark — is paid for in artwork rather than in a few misplaced letters.
   The code comments already concede this: *"It is visibly an addition to the artwork rather than a
   repair of it."*
2. **The polygon is the outer contour**, so the balloon's black stroke is inside the fill (D2).
3. **`maskPolygon` has two jobs** — where to erase, and where text may flow. They want different
   shapes (erase tight to glyphs; flow inside the balloon interior), and one field cannot be both.

---

## 7. A negative result that changes the plan

My first instinct was that the mask could be built with OpenCV alone: estimate local background by
morphological closing/opening, threshold the difference, dilate. I prototyped it and initially
reported 99.1 % recall at 85.3 % precision against toriitranslate.com's footprint.

**That number was wrong, and I am correcting it.** It was computed on the pixels that *changed after
inpainting*, not on the mask. On a white balloon a slab-shaped mask painted white over white changes
nothing, so the metric flattered a mask that was not glyph-shaped at all. Measured properly:

| | coverage | components | median component |
|---|---|---|---|
| toriitranslate.com | 2.64 % | 295 | 215 px |
| morphology v1 (kernel from region size) | 12.00 % | 11 | 36,853 px |
| morphology v2 (kernel from measured stroke width) | 7.13 % | 12 | 17,260 px |
| ours today | 15.69 % | 7 | 62,436 px |
| **CTD seg head (measured 2026-08-26)** | **3.20 %** | **122** | **194 px** |

*(CTD row added after the fact — median over 21 corpus pages. See
`docs/ctd_mask_validation_2026-08-26.md`. It confirms the conclusion below: the granularity comes
from a learned per-pixel map, and CTD delivers it. Coverage corrected 2026-08-27 from 3.42 %, which
was the 20-page median taken before sample184 was replaced by sample28.)*

Rendered, v2 is a solid vertical slab over the text column. Precision against toriitranslate.com's footprint is
**36.9 %**, not 85 %.

**Conclusion: there is no classical shortcut to glyph-level masking.** MIT gets glyph granularity
from a *learned per-pixel text-probability map* refined by DenseCRF — steps 1, 6 and 8 above are load-
bearing and morphology substitutes for none of them. Phase 1 must therefore adopt a
text-segmentation model, not hand-rolled morphology. This is the single most important finding here,
and it only surfaced because the first answer was checked.

---

## 8. Which inpainter, and when

Scored against toriitranslate.com's plate, using toriitranslate.com's own glyph mask, so the inpainter is isolated from mask
quality:

| | PSNR vs toriitranslate.com | MAE | time (2 threads) |
|---|---|---|---|
| AOT ONNX @1024 | 35.44 dB | 2.7 | 10.0 s |
| `cv2.inpaint` TELEA | 33.78 dB | 3.0 | **0.4 s** |

On flat balloon interiors TELEA is within 1.7 dB of a neural inpainter and **25× faster**. But on a
controlled test — text composited over real artwork from this page, so ground truth is known — the
ordering is decisive:

| patch (detail σ) | TELEA | AOT |
|---|---|---|
| σ=41.3 | 10.62 dB / MAE 49.1 | **12.46 dB / MAE 30.1** |
| σ=41.2 | 11.88 dB / MAE 43.9 | **14.14 dB / MAE 27.0** |
| σ=40.5 | 9.08 dB / MAE 58.0 | **11.05 dB / MAE 34.9** |

**So: route by local complexity.** We already compute exactly the statistic needed —
`_pixel_spread`, the per-channel median-absolute-deviation behind `BACKGROUND_FILL_MAX_SPREAD`. It
currently gates *whether to fill*; it should instead gate *which erasure method*. That turns the
D3 status note ("the check is correct and the capability is missing") into the router.

- interior flat (MAD below threshold) → **TELEA**, ~0.4 s/page
- interior structured → **AOT on a padded crop**, ~1.5–2.5 s/crop

Typical page: one TELEA pass plus one or two neural crops ≈ **5–7 s**, comfortably inside the 60 s
bar. Whole-page AOT at 1024 is 10 s and is the fallback, not the default. `lama_large` at 512 px was
23–38 s on 2 threads — too slow for this box; keep it behind a flag for a GPU worker.

Hardware note: this host has 4 cores / 19 GB, worker capped at `WORKER_CPUS=2.0` / 4 GB, and a
GeForce 940MX that is too small to matter. Plan for CPU.

---

## 9. The plan

### Phase 0 — separate erasure from typesetting (no ML)

The enabling refactor. Nothing below works until the plate exists.

1. New MinIO artifact `cleaned/{image_id}.png` alongside `originals/`, `rendered/`, `thumbnails/`.
2. New worker stage + queue `inpaint`, handler `process_inpaint`, placed **after QA** so the region
   set is final (copying MIT's deliberate deferral). Cache-key the plate on
   `(image_id, hash(final region geometry + mask params))` — toriitranslate.com's `_cacheKey` is
   `hash(image)-hash(config)`, same idea.
3. `render.py` and `Reader.tsx` stop filling anything. Base layer becomes the plate; the renderer
   only draws text. This alone deletes D5 (mask/text interleaving) because there are no masks left
   to interleave.
4. `maskPolygon` keeps only its typesetting job — flow constraint and largest-inscribed-rectangle.

### Phase 1 — a real text mask

5. Add a text-segmentation model. **CTD (comic-text-detector) ONNX, 94.8 MB** is the right first
   choice: it is manga-specific, ships a `mask` head alongside `lines`, and is a third the size of
   DBNet's 306 MB. Load it the way `bubble_detector.py` already loads YOLO — ONNX Runtime, CPU EP,
   pinned SHA-256.
6. Implement `services/text_mask.py` as a **from-scratch, clean-room implementation** of §4
   steps 3–10, written from the behavioural description in this document — not a port. The licence
   decision does not change this: adopting GPL-3.0 for our own output is a separate question from
   how the implementation is derived, and the whole point of the exercise is to understand the
   technique well enough to beat it, which copying does not achieve. The two
   steps that carry the quality are **`area_cc >= area_textline_polygon` rejection** and the
   **1-px AABB cut**; DenseCRF is the third and can be deferred (`pydensecrf` is a C extension and
   an awkward dependency — evaluate `cv2.ximgproc.guidedFilter` as a substitute first, and measure
   whether it is needed at all).
7. Keep the **eroded** bubble polygon, not just its bounding rect, and scale erosion to the bubble's
   minor axis rather than a flat 3 px (D2).

### Phase 2 — the inpainter

8. `services/inpaint.py`: ONNX AOT with the contract measured in §5 — RGB, `[-1,1]`, hole zeroed,
   pad (do not stretch) to a multiple of **32**, saturating cast back, hard binary composite at 127.
9. Tiered routing on `_pixel_spread` per §8, with per-region crops padded for context.
10. Sample `fillColor`/`strokeColor` from the glyph mask directly — fg = median inside the mask,
    bg = median of the dilated-minus-glyph ring. We cannot use MIT's approach (their fg/bg come from
    *regression heads on the OCR decoder*, `color_pred_fg`/`color_pred_bg` in `ocr/model_48px.py:537`;
    PaddleOCR has no such head) but with a glyph mask in hand, sampling is both trivial and more
    direct. Fixes D9's colour bullet.

### Phase 3 — typography, now unblocked

11. Stroke width proportional to font size. MIT's own renderer uses **0.07**; the `TextBlock` default
    that toriitranslate.com inherits is **0.2**. Start at 0.07–0.1.
12. Stroke only when it earns its place: MIT gates on `color_difference(fg,bg) > 15`, CIE76 ΔE in
    CIELAB with the L\* term scaled by **0.392** (an 8-bit-LAB unpacking correction, not a perceptual
    tweak).
13. Ship a lettering face (D9). Licensing still unresolved — Comic Neue is OFL, Wild-Words-alikes
    mostly are not.

---

## 10. Acceptance bar

`scripts/render_quality_metrics.py` already exists and is the regression gate. The corpus already
carries **211 pages with a mangatranslator.ai rendering** and 53 with a human one — that is
the eval set, no new labelling required.

- **Phase 1 gate — mask geometry.** Median connected-component area of the mask must fall below
  **2,000 px** (today: 62,436). Component count per page should rise into the hundreds. This is the
  measurement that catches a slab pretending to be a mask, and it is the one my prototype failed.
- **Phase 2 gate — `flattened`.** Mean ≤ **2.5 %**, max ≤ **5 %** (today: mean 6.85 %, max 16.04 %;
  reference mean 1.92 %). No page may contain a flat blob larger than **1.3 %** of the page — no
  reference output, commercial or human, ever does.
- **Latency gate.** p95 page wall-clock unchanged; inpaint stage ≤ 10 s on 2 cores.

---

## 11. Risks

- ~~**CTD mask quality on our corpus is unmeasured.**~~ **RESOLVED 2026-08-26** — measured on 21
  pages, gate passes by ~10× (median component 194 px vs ≤ 2,000 px). Three consequences:
  use the **seg-only dynamic subgraph** (41 % faster, identical mask); the shipped mask is
  **`CTD ∩ region set`** (raw CTD also finds SFX and artwork lettering we never replace); and use
  **per-region crops at native scale**, since whole-page 1024² merges small text into blobs
  (sample106: 17 components / 4,466 px median). Full results and caveats in
  `docs/ctd_mask_validation_2026-08-26.md`.
- **Cost is now the binding risk, not mask quality.** CTD is 128 s/page published / 75.7 s trimmed
  on 4 cores, against a latency gate of 10 s on 2. Per-region cropping is the proposed fix and is
  **not yet measured**.
- **DenseCRF may turn out to be load-bearing.** If the guided-filter substitute does not snap to
  strokes, `pydensecrf` becomes a required C extension in the worker image.
- **Memory.** MIT allocates one full-frame buffer *per textline* (`text_mask_utils.py:104`) —
  ~280 MB on a dense page. Do not copy that; accumulate into one buffer with per-textline ROIs. The
  worker is capped at 4 GB.
- **Plate invalidation.** Region edits, re-OCR and redo paths must invalidate the cached plate or
  the page will silently render text over stale erasure.
- ~~**Licence.**~~ **RESOLVED 2026-08-26 — the project adopts GPL-3.0.** manga-image-translator and
  the Rust port are both GPL-3.0; Sagnik is content to license this project the same way, citing
  [yt-diff](https://github.com/sagniKdas53/yt-diff) as existing precedent, and weights are consumed
  as artifacts without qualification.

  **This does not license us to copy.** Clean-room reverse engineering remains the method for every
  phase: implementations are written from behavioural analysis, not ported. The licence answers
  *what we may publish*, not *how we may derive it* — and the objective is to understand these
  techniques well enough to surpass them, which a port does not deliver.

  Two follow-ups this creates, neither blocking:
  1. Add `LICENSE` (GPL-3.0) at the repo root and state it in the top-level README — the repo has no
     licence file today.
  2. GPL-3.0 is copyleft and reciprocal. It obliges anyone distributing the service's *binaries* to
     offer source, but the AGPL network clause does **not** apply — running this as a hosted service
     does not by itself trigger distribution. Worth being deliberate about if the project is ever
     offered as a service.
