# Prior art for region merging — 2026-08-08

Why this exists: `region_threshold_validation_2026-08-08.md` landed on `threshold_ratio=0.35`
by measurement, and the value looked oddly small. It is. Every comparable system uses a distance
budget of **1.5–4× character size** — close to the `2.0` we condemned. This document explains why
they can, what they have that we don't, and what to take from them.

**The short version:** our `0.35` is not a tuned parameter, it is a workaround. Distance is the
only gate we have, so it has to do the work of four. Mature implementations use a loose distance
bound plus several cheap agreement checks, and the best of them derive the cut from the image
instead of configuring it.

---

## 1. What this problem is called

We were searching for the wrong words. The general problem is **bottom-up page segmentation** /
**text line grouping** / **text block aggregation**, from document layout analysis — a field that
predates manga OCR by thirty years.

| method | year | idea | threshold handling |
|---|---|---|---|
| **RLSA** (Wahl, Wong, Casey) | 1982 | smear runs of foreground horizontally/vertically, take components | fixed, hand-set |
| **Docstrum** (O'Gorman) | 1993 | k-nearest-neighbour clustering of components; angle + distance | **estimated per page** from the nearest-neighbour distance histogram |
| **Voronoi** (Kise et al.) | 1998 | area Voronoi diagram of components, cut edges over a threshold | statistical, from the page |
| **RLSO** (Ferilli et al.) | 2012 | RLSA with thresholds set automatically | automatic |
| **Rigaud et al.** | 2020 | dilate component boxes until the block count is most stable | **parameter-free** |

The pattern is a one-way ratchet: every generation moves the threshold from "configured" to
"measured from the image". We are still at 1982.

Docstrum is the key idea to internalise. A histogram of nearest-neighbour distances on a page has
peaks that land naturally on *between-character*, *between-word* and *between-line* spacing. The
algorithm reads the spacing off the page rather than being told it. Our `OCR_MERGE_THRESHOLD` is
an attempt to supply, by hand and globally, a number the page already contains.

## 2. Rigaud, Nguyen & Burie 2020 — the closest published match

*"Text block segmentation in comic speech bubbles"*, MANPU @ ICPR 2020
(doi:10.1007/978-3-030-68780-9_22). The PDF is gitignored — this repo is public and the paper is
Springer's. A local copy used to sit in `docs/`; it has since been deleted. Fetch it by title or DOI if needed.

This is our BUG-2, stated as a research problem: **multiple text blocks inside a single speech
bubble**, caused by balloons drawn connected to each other. Their Fig. 2 is our `sample3`.

### The method — three steps, no parameters

1. **Content detection.** Connected components inside the bubble region; take their bounding boxes.
2. **Box enlarging.** Grow every box pixel by pixel, in width and height, centred on the original.
   After each iteration, count the contours in the resulting mask. Growth is clipped to the
   balloon outline. The count starts high (38 in their example) and falls in steps as boxes
   coalesce. **Stop at the beginning of the longest run of a constant count before it collapses
   to one/zero** — in their example, the plateau at 2 contours.
3. **Text block detection.** External contours of that mask are the text blocks.

Reported empirically: the stopping point lands between **2× and 4×** the original box width and
height.

### Why this matters to us

**Their stopping rule is our plateau heuristic, automated.** In the validation doc I argued you
should pick a value sitting in the *middle of a wide flat stretch* rather than the value with the
best score, because a value at a cliff edge is right by luck. Rigaud's algorithm does exactly
that — except it runs the sweep *per bubble at run time* and takes the widest plateau as the
answer, so no constant is ever chosen by a human.

This is the same principle as **MSER** (Maximally Stable Extremal Regions): sweep a threshold,
keep the structure that survives the longest stretch of it. Useful search terms for more of this:
*scale-space stability*, *persistence*, *stability-based model selection*.

That convergence is the strongest argument in this document. We arrived at "widest plateau" from
seven pages of measurement; the literature arrived at it as an algorithm. We should stop using it
to pick a constant and start using it as the constant's replacement.

### Their stated limitations — all of which we would inherit

- Works on **detached (non-cursive)** writing; word size varies more than character size and
  blurs block boundaries.
- **Fails when two blocks are closer than about one letter/symbol size.** This is precisely our
  `sample27` panel-1 failure, seen from the other side.
- Width and height growth are **inter-dependent**; they flag decoupling as future work,
  specifically for non-Latin scripts.
- Small isolated components (e.g. the dots of 「…」) fail to merge and become spurious blocks.
- Vertical Japanese works, and furigana get absorbed into their parent column.

### And a gap worth noting

**No public dataset annotates multiple text blocks inside a bubble.** eBDtheque annotates text
lines (21 connected-bubble cases in 1081 balloons, ~2%); Manga109 annotates one block per bubble
(147,918 boxes, unchecked). Rigaud could therefore only evaluate **qualitatively**, by eye, and
the paper closes by asking for exactly that annotation.

Two consequences. First, our by-eye ground truth is not a shortcut — it is the state of practice
for this specific problem. Second, `corpus/ocr/` is closer to a contribution than we thought.

## 3. What the working implementations do

`zyddnys/manga-image-translator` (`manga_translator/textline_merge/`) and
`dmMaze/comic-text-detector` (behind BallonsTranslator) both solve our problem in production.
They agree on five things, and we do none of them.

| | them | us (`merge_regions.py`) |
|---|---|---|
| **yardstick** | font size of **the pair being compared** (`max(fs1, fs2)`) | `avg_width` over **every fragment in the call** |
| **distance budget** | `1.5 × fs` (m-i-t, `gamma=0.5`); `2 × fs` (c-t-d) | `0.35 × avg_width` after our fix |
| **alignment gate** | angle within `0.2π` (~36°); or `cos > 0.866` (~30°) | none |
| **size-similarity gate** | `fntsize_tol = 1.3` | none |
| **adaptive cut** | `distance ≤ mean + 2σ` of observed distances | none |
| **graph** | minimum spanning tree, cut long edges | transitive closure (connected components) |
| **orientation** | majority vote over box geometry | global `reading_direction` job setting — **BUG-6** |

Read the yardstick row together with the distance row. Their budget is ~4–6× looser than ours
*and* they still don't over-merge, because three other conditions must also hold. We removed the
other conditions and paid for it by shrinking the one we kept until it strangled legitimate
merges. That is `sample27`.

The page-global `avg_width` is the subtler defect. On a page mixing a shout, ordinary dialogue and
a small sub-caption, one average is the wrong yardstick for all three — which is exactly why a
single value has not transferred cleanly across our seven pages.

## 4. What to do about it

In payoff order. None of these is the cloud re-run; they are worker changes.

1. **Pairwise size instead of a group average.** Smallest diff, and it is the reason our value
   doesn't transfer between pages. Do this before touching the number again.
2. **Add the alignment and size-similarity gates.** These are what let the distance budget go back
   up to something forgiving, recovering the `sample27` over-split without reintroducing
   cross-balloon fusion.
3. **Fix orientation (BUG-6)** — majority vote over fragment aspect ratios, not the binding
   direction. Already evidenced; blocks any honest re-assessment of BUG-4.
4. **MST + edge cutting instead of transitive closure.** The structural fix BUG-4 was reaching
   for, and the literature's answer to unbounded chaining.
5. **Then consider Rigaud.** It operates on the *bubble crop image* and connected components, not
   on OCR fragment boxes, so it is not a drop-in — it would sit **before** OCR and replace the
   merge heuristic rather than tune it. Highest ceiling, largest change.
   **Downgraded 2026-08-09:** the cheap version of this — porting the dilation stopping rule onto
   our fragment boxes — is off the table. Persistence rules need dozens of primitives to show a
   plateau; our fragments number 2–6 per balloon and the count falls from N to 1 in one step.
   Rigaud-on-pixels survives the argument, but nothing cheaper does. See
   `region_grouping_plan_2026-08-09.md` §1(b), and experiment E5 there, which settles it by
   measurement rather than by argument.

Note that 1–4 make `threshold_ratio` progressively less load-bearing. If they land, expect the
right value to move back up toward 1.5–2.0, and expect it to matter less. **`0.35` is correct for
the algorithm we have today and should not outlive it.**

## 5. Open questions — answered 2026-08-09

Handed to research agents in `docs/research_brief_region_merging.md`; the answers are worked
through in `region_grouping_plan_2026-08-09.md`.

- ~~Is our edge-gap distance metric comparable to their box distance?~~ **Both use minimum edge
  gap — we had the metric right.** The gap is entirely the *denominator*: they normalise by
  `max(width)` of the pair, we normalise by the mean over every fragment on the page. Under local
  normalisation the ratio reads as "characters of white space", which is why `1.5` is sayable in
  words and `0.35` is not. Expect the value to rise to ~1.0–1.5 once normalisation is local.
- ~~Does Rigaud's stopping rule work on OCR line boxes?~~ **No** — see the note in §4.5 above.
- ~~Is there a post-2020 successor, and did anyone build the dataset?~~ **Yes, and it is the most
  useful thing we found.** Manga109-v2026 (arXiv:2605.21182) re-annotated Manga109; its largest
  fix category is *under-segmented speech balloons* — connected balloons in one box, split per
  balloon — at ~14,900 cases. That is BUG-2 with ground truth. Manga109-s permits commercial use
  of results; neither may be redistributed.
- How do Docstrum-style per-page estimates behave on a manga page, where a bubble holds far fewer
  words than a document page? Rigaud explicitly warns that comic bubbles contain too few words for
  thresholds to be learned from them — which is why he dilates instead.

## 6. Sources

- Rigaud, Nguyen, Burie. *Text block segmentation in comic speech bubbles.* MANPU@ICPR 2020.
  [doi](https://doi.org/10.1007/978-3-030-68780-9_22) · local PDF in `docs/`, gitignored
- O'Gorman. *The Document Spectrum for Page Layout Analysis.* IEEE TPAMI 15(11), 1993.
  [doi](https://doi.org/10.1109/34.244677)
- Wahl, Wong, Casey. *Block segmentation and text extraction in mixed text/image documents.* 1982.
- Kise, Sato, Iwata. *Segmentation of page images using the area Voronoi diagram.* CVIU 70(3), 1998.
- Shafait, Keysers, Breuel. *Performance evaluation and benchmarking of six page segmentation
  algorithms.* IEEE TPAMI 30, 2008. [doi](https://doi.org/10.1109/TPAMI.2007.70837)
- [zyddnys/manga-image-translator — `textline_merge`](https://github.com/zyddnys/manga-image-translator/blob/main/manga_translator/textline_merge/__init__.py)
- [dmMaze/comic-text-detector](https://github.com/dmMaze/comic-text-detector)
- Manga109 (Aizawa et al., IEEE MultiMedia 27(2), 2020) · eBDtheque (Guérin et al., ICDAR 2013)
