# Threshold validation beyond sample3 — 2026-08-08

Executes §4.1 of `ocr_region_handoff_2026-08-08.md`: the `threshold_ratio ≤ 0.5` finding was
derived from one page (`sample3`) against a balloon count read off the reference by eye. This
validates it on six more pages, with `sample23` as the control.

**Outcome in one line:** the direction of the fix holds everywhere — `2.0` is the worst or
joint-worst value on all seven pages — but the recommended band was one notch too loose. Use
**0.35**, not 0.5. Separately, the control page turned up a different bug entirely.

---

## 1. Method

Ground truth is a by-eye count of *text areas* on each page, taken from the human reference
where one exists and from the source page otherwise. Same method as the original sample3 count,
with the same limitation — see §5.

The original sweep script swept one threshold into **both** merge paths at once. Production does
not do that:

| call site | threshold | governed by |
|---|---|---|
| `ocr.py:605` — split fragments *inside* a YOLO bubble | hardcoded `2.0` | BUG-2 |
| `ocr.py:663` — merge fragments YOLO matched to *no* bubble | `OCR_MERGE_THRESHOLD` env | BUG-4 |

Sweeping both together conflates the two and makes the `sample23` control meaningless, because
`sample23` has no bubbles at all. The sweep here moves only the in-bubble threshold and pins the
unmatched path at the code default (`0.50`), which isolates BUG-2.

Tooling: **`scripts/region_proposal_probe.py`** (promoted from the scratchpad, since this is now
routine). It runs no engine against the corpus and writes nothing to it.

```bash
.venv/bin/python scripts/region_proposal_probe.py sweep     sample30 --truth 7
.venv/bin/python scripts/region_proposal_probe.py overlay   sample27 --in-threshold 0.35
.venv/bin/python scripts/region_proposal_probe.py direction sample23 --truth 17
```

## 2. Hand counts

| sample | reference used | truth | notes |
|---|---|---|---|
| `sample3` | human | 9 | 8 balloons + the name badge; re-counted, agrees with the earlier count |
| `sample1` | none — machine TL only | 4 | counted off the source; unambiguous |
| `sample30` | human | 7 | |
| `sample16` | human | 10 | |
| `sample9` | human | 18 | dense 4-panel page; see §5 |
| `sample27` | human | 18 | dense 4-panel page; see §5 |
| `sample23` | none — machine TL only | 17 | control; text-layout page, no balloons |

## 3. In-bubble sweep, unmatched path pinned at 0.50

Region counts. **✓** = matches the hand count.

| sample | truth | 0.15 | 0.25 | 0.35 | 0.50 | 0.75 | 1.0 | 1.5 | **2.0 (current)** |
|---|---|---|---|---|---|---|---|---|---|
| `sample3` | 9 | 9 ✓ | 9 ✓ | 9 ✓ | 9 ✓ | 8 | 8 | 6 | 6 |
| `sample1` | 4 | 4 ✓ | 4 ✓ | 4 ✓ | 4 ✓ | 4 ✓ | 4 ✓ | 3 | 3 |
| `sample30` | 7 | 7 ✓ | 7 ✓ | 7 ✓ | 6 | 6 | 6 | 4 | 4 |
| `sample16` | 10 | 9 | 9 | 9 | 9 | 9 | 9 | 8 | 8 |
| `sample9` | 18 | 15 | 15 | 15 | 14 | 13 | 12 | 11 | 11 |
| `sample27` | 18 | 20 | 20 | 20 | 20 | 19 | 19 | 16 | 15 |
| `sample23` | 17 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |

### What holds

**The direction of the fix is confirmed on every page.** `2.0` is the worst or joint-worst
value everywhere. Relative to the best achievable count it loses 3 regions on `sample3`, 3 on
`sample30`, 4 on `sample9`, 1 on `sample1`.

**`sample30` reproduces `sample3` exactly.** 4 YOLO bubbles, 0 unmatched fragments, 7 balloons —
and at ≤0.35 the seven regions map **1:1 onto the seven balloons**, verified against the art, not
just against a count. This is the strongest single confirmation: the page was picked for having
the same touching-balloon shape as `sample3`, and it behaves identically.

### What does not hold

**0.50 is too loose.** `sample30` needs ≤0.35; at exactly 0.50 it drops to 6. The intersection
of the exact-match bands across the pages that can match at all is **0.15 – 0.35**, not 0.15 –
0.50. The original figure came from `sample3`, whose band happens to extend to 0.50.

**`sample27` over-splits, and it is the only page that does.** 20 regions against a truth of 18.
Inspecting the overlay, the two extra regions have different causes:

1. Panel 1's balloon 「オタクくん」/「放課後デート しようよ」 splits in two. This is a **genuine
   threshold over-split** — the gap between the name and the line exceeds the budget until 0.75.
2. The large borderless shout in panel 2 splits into a `bubble` region and a `direct_text`
   region, because YOLO drew a bubble around the 「オタクくん」 half and left the rest unmatched.
   **No threshold can merge this** — the two halves are produced by different code paths.

So the honest cost of tightening is **one over-split region, on one of seven pages**. Weighed
against 11 regions recovered across the other four, tightening is clearly right.

**`sample16` and `sample9` never reach truth, and the threshold is not why.** Both plateau below
their hand count at every value. On `sample9` the 3-region gap is one SFX (「もぐもぐ」) never
detected at all, plus two balloons whose text merges with an adjacent sub-caption inside a single
YOLO bubble — neither is a threshold effect. Lowering the threshold still recovers 4 regions
(11 → 15) on that page. Neither page over-splits at 0.15.

### Recommendation

**`threshold_ratio=0.35`** at `ocr.py:605`. It is the only value that matches on every page that
can match, and no page tested does better at 0.50 than at 0.35. Note this is *not* the module
default (`OCR_MERGE_THRESHOLD=0.50`), so the override at that call site should stay — with a new
value and a comment, not deleted.

## 4. Control: passed, and it found something else

### The control passed

`sample23` is **constant at 2 regions across the entire in-bubble sweep**. YOLO returns 0
bubbles, so the `2.0` override at `ocr.py:605` never executes on this page. §4.1's condition —
"if the threshold changes sample23's count, the model of the bug is wrong" — is satisfied. BUG-2
is correctly scoped to the in-bubble path.

(The earlier combined sweep *did* move `sample23`, from 17 regions down to 1. That was the
script sweeping the unmatched path too, not evidence against the model.)

### BUG-6 · `reading_direction` is used as a proxy for text orientation

While confirming the control, the reason `sample23` collapses to 2 page-sized regions turned out
not to be chaining at all.

All 61 fragments on the page are **horizontal**: average 214×33 px, 61 of 61 wider than tall.
`merge_regions.py:103-107` reads:

```python
# For vertical Japanese text (typically reading_direction == "rtl"),
# the character/font size is represented by the line's width [...]
char_size_vertical = avg_width if reading_direction == "rtl" else avg_height
max_vertical_gap = char_size_vertical * threshold_ratio
```

On horizontal text `avg_width` is a whole line, so the vertical gap budget becomes ~107px at the
code default and ~214px at the deployed `1.0` — comfortably more than the paragraph spacing.
Every paragraph chains into its neighbour.

Merging the same fragments with `ltr` instead:

| `threshold_ratio` | `rtl` (vertical assumption) | `ltr` (horizontal assumption) |
|---|---|---|
| 0.15 | **17** | 34 |
| 0.25 – 1.0 | 2 | **17** ✓ (stable across the whole band) |
| 1.5 – 2.0 | 1 | 1 |

`ltr` yields exactly the hand count of 17, and does so across a wide, stable band. Verified
against the art: each of the 17 regions is exactly one paragraph. The `rtl` path hits 17 only at
a knife-edge 0.15 — a coincidence of the wrong geometry, not a fix.

**The conflation.** `reading_direction` comes from `job_data["readingDirection"]`
(`ocr.py:339`, default `"rtl"`). That is a **binding / page-order** setting — which way panels
are read. `merge_ocr_regions` reuses it as a **text-orientation** flag. For Japanese manga the
two usually coincide, which is why the comment says "typically". Every Japanese job is `rtl`, so
every horizontally-set Japanese page — profile pages, narration blocks, author notes — gets
vertical geometry applied to horizontal lines.

**This relocates BUG-4.** `sample23` r1 (458×1505) is a direction bug, not unbounded
connected-components chaining. The handoff's conclusion that the constraint "has to come from
elsewhere — panel membership or a cap on component extent" is not needed for this page.
Orientation is derivable from the fragments already in hand: 61/61 wider than tall is not a
close call. BUG-4's transitive-chaining argument may still be real on genuinely vertical pages —
this does not clear it — but its headline evidence no longer supports it.

**Blast radius.** `impact({target: "merge_ocr_regions", repo: "manga-tl-worker"})` — **LOW**,
1 direct caller (`process_ocr`), 1 process, 1 module.

**Also still unapplied:** `docker-compose.yml:220` deploys `OCR_MERGE_THRESHOLD=1.0`, double the
`0.50` code default. Flagged as fix #1 in `render_quality_gap_2026-08-05.md` §D4 and never done.
It governs the unmatched path — the one this bug hits hardest.

## 5. What this does not establish

- **Ground truth is still by eye.** Seven pages instead of one, and `sample30` and `sample23`
  were checked region-by-region against the art rather than by count alone — but no page has an
  independent hand-annotated region set.
- **Two counts involve judgement.** On `sample9`, whether 「私ケイちゃんの恋バナ聴くの好きなんだ」and
  its smaller sub-caption 「ご飯進むから」are one area or two; same for 「って」 and
  「何ニヤニヤ笑ってるんですか」. On `sample27`, whether panel 3's two column groups sit in one
  balloon. Each is ±1. None of them change the ordering of thresholds.
- **Nothing here measures OCR accuracy.** These are region-proposal counts. Whether better
  regions produce better transcriptions still needs the bundled cloud re-run.
- **`sample23` is one horizontal page.** The direction fix is validated on it alone. Before
  changing orientation handling, check it against a genuinely vertical page to confirm the
  detection does not flip the common case.

## 6. Suggested order, revised

1. **BUG-1** — unchanged; benchmark-only, no product risk.
2. **BUG-6** (new) — derive text orientation from fragment aspect ratios instead of
   `reading_direction`. Needs worker tests. Cheap, LOW blast radius, and it is a prerequisite for
   judging BUG-4 honestly.
3. **BUG-2** — `2.0` → `0.35` at `ocr.py:605`. Validated here; needs worker tests.
4. **`OCR_MERGE_THRESHOLD` 1.0 → 0.50** in `docker-compose.yml` to match the code default.
5. **BUG-3** — polygon masking, unchanged.
6. **BUG-4** — re-assess *after* BUG-6, on a vertical page.

Bundling still applies: 1, 2, 3 and 6 all change region proposals and invalidate every stored
`candidate`. One cloud pass.
