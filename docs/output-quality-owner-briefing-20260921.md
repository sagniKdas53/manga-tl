# Where the output-quality rewrite really stands

Owner briefing, 2026-09-21. Read this tomorrow before the technical tracker.

## The short version

We have made real improvements, but we do **not** yet have a reliably fast, Torii-like finished pipeline.

The strongest improvements are better production rendering, fewer destructive white patches, less duplicated OCR, and better grouping of text belonging to one balloon. The background-cleanup machinery now exists, but it is too slow and has visible defects. **The full text-fitting improvement is still ahead of us.**

The next step is to make cleanup a predictable, recoverable stage, remove its redundant second detection pass, and measure the result honestly. Then connect the editor to the same cleanup assets and fix fitting. Do not start another broad rewrite or buy a larger model as tomorrow's first move.

This document is advice and a handoff, not a claim that those changes have shipped.

## What actually improved since we started?

This is a comparison with the starting behavior recorded in the checkpoints, not a fresh before/after benchmark against today's remote master. The inspected branch is feat/output-quality at parent ab86d20 / worker ac7cbba. Its locally recorded github/main base is d570f23; local main is a different revision.

| Area | Real improvement | What it does not mean |
| --- | --- | --- |
| Rendering | The live pipeline now uses the Chromium/shared-scene renderer; it previously still used worker/Pillow typography despite the browser renderer existing. | Every editor/export path is not yet identical. |
| White patches and lettering | R2 removed oversized synthetic free-text plates and improved outline/stroke drawing. | Background artwork is not universally reconstructed correctly. |
| OCR duplication | One stress page went from 214 stored OCR rows for 63 boxes to 63 rows/63 boxes. | OCR accuracy and reading order are not solved on every page. |
| Balloon grouping | Multi-column text in one balloon is again treated as one translation/text block on the tested shortlist. | This fixes ownership, not English font sizing. |
| Artifact freshness | Revision/digest tracking makes it harder to serve old output as current. | Recovered job attempts still need stronger callback/advancement safety. |
| Cleanup | Detected text masks and reconstructed background patches can reach the server-rendered page. | R3 has not passed speed or complete visual acceptance; the editor still lacks these assets. |
| Translation/runtime fixes | Concurrency, a reasoning-token cap, and a newline correction landed in source. | Their combined live speedup has not been measured by the retained runs. |

Evidence: [R1](quality-checkpoints/R1.md), [R2](quality-checkpoints/R2.md), [R6](quality-checkpoints/R6.md), [freshness checkpoint](quality-checkpoints/G2.md), and the [corrected R3 handoff](quality-checkpoints/R3-phase-separation-handoff-20260921.md).

Some fitting code was shared/extracted and some presentation improved. That is not the same as completing the fitting redesign. The current automatic starting-size calculation still has a 72 px limiting behavior; narrow columns, readable sizing, collisions, overflow, padding and hierarchy remain. On sample93, the comparison recorded median sizes of 72 px here versus 139 px in Torii. A single larger font setting will not solve all of those layout problems.

## Why it is slow, and whether it is becoming unpredictable

There are two different jobs hidden inside the word “inpainting”:

1. Find the exact pixels of the original lettering: the text mask.
2. Fill those pixels with a plausible background: the reconstruction.

For sample61, recorded cleanup took roughly **1,038 seconds**:

- First CTD text-detection pass: about 519 seconds.
- Second CTD recheck: about 514 seconds.
- Actual background reconstruction: about 5 seconds.

So the immediate bottleneck is **repeated text-mask detection**, not the model painting the background. Page OCR added another 203 seconds. Removing the recheck projects about **12.2 minutes for OCR plus cleanup**, still before translation/render/QA. That is an estimate from subtraction, not a measured optimized run. [Timing and limitations](quality-checkpoints/R3-phase-separation-handoff-20260921.md#what-the-retained-runs-demonstrate).

Separating cleanup from OCR gives us clearer progress and safer recovery. It does not itself make inference faster. Nor does increasing a timeout make the pipeline fast.

Your concern about losing a linear pipeline is reasonable. The intended normal path should stay:

**OCR → cleanup → translation → render → QA → complete or review**

Existing bounded QA retries remain; this is not an unlimited agent loop. Stable region IDs must keep results associated with the right text even when translation requests finish in a different order.

There are two meanings of “deterministic”:

- **Predictable execution:** one authorized next stage, bounded retries, no stale attempt overwriting new work, explicit failure states. We should require this.
- **Identical new AI output every time:** remote OCR/translation/generation calls cannot be promised to reproduce identical text, pixels or timing. Save their accepted outputs so replay does not unnecessarily call them again.

The current recovery protocol is not yet strong enough for the first guarantee. Heartbeats alone are insufficient: an old attempt must not write results or advance a recovered job. Also, QA once returned only 38 verdicts for 63 regions and still logged a pass. That needs fixing before “passed” is trustworthy.

The three named run directories are not three successful six-page experiments. Together the capped runs captured five distinct fixtures; sample61's export is missing. Some elapsed time includes interruption/recovery. Visible smearing, outline remnants and tiny text remain. **R3 is not passed.**

## What should I ask the agent tomorrow?

Copy this:

> Read docs/output-quality-owner-briefing-20260921.md and the corrected R3 phase-separation handoff. Implement its first bounded delivery: write the concrete transition/recovery contract, then implement attempt-safe recovery and the sequential cleanup stage using existing seams. Keep the normal path OCR → cleanup → translation → render → QA. Keep the 1024 CTD cap and current reconstruction routing; remove the unconditional second CTD pass. Do not introduce parallel cleanup, another renderer, a general scheduler rewrite, or a new image provider.
>
> Cover stale/duplicate callbacks, restart, edit/cancel, partial failures and durable next-stage dispatch with focused tests. Reuse recorded inputs for cheap checks. Report exactly what passed, what was skipped, and what remains; stop before any new paid benchmark or deployment that needs separate approval. Do not mark R3 passed or claim a measured speedup without the evidence.

This is the [technical handoff's Packets 1–2](quality-checkpoints/R3-phase-separation-handoff-20260921.md#next-work-in-bounded-packets), not permission for endless planning. The specification should end with concrete payloads, transitions, files and tests, then lead into implementation. If its shared-code impact proves larger than that bounded delivery, the agent should explain and split it, not quietly expand scope.

After that delivery:

1. Fix incomplete QA accounting: missing verdicts must mean incomplete/review, not success.
2. Measure cleanup independently of translated text, then run a small controlled live canary under an agreed spend limit. Record per-stage time, total page time, retries, cost and actual hardware. No mid-run rebuild.
3. Complete the six-fixture and agreed control gate, with visible crops and cleanup-only artifacts. If speed still fails, name that failure and propose one measured next optimization.
4. Integrate cleanup into the editor (R7), then tackle fitting (M7).
5. Finish output/archive consistency (M8), then broader corpus/release acceptance (M9).

You should only need to judge a small result summary: **what looks better, what still looks wrong, how long it took, what it cost, and the next bounded change.**

## How close can we get to Torii on our hardware and budget?

The documented local test machine is an i5-7200U-class CPU system; these cleanup runs are CPU-constrained. That is historical run context, not a fresh inventory of every machine you own. We have no evidence for a percentage such as “90% of Torii,” nor an approved numeric page-time/spend target for the revised pipeline.

A realistic direction is:

- Make ordinary dialogue pages dependable and inexpensive first.
- Preserve artwork conservatively; explicitly send uncertain cases to review.
- Make the editor genuinely useful for the remaining exceptions.
- Consider cloud reconstruction only for selected difficult patches, if a small experiment earns its place.

The main remaining gaps are **cleanup speed/accuracy, editor parity, English fitting, and trustworthy end-to-end acceptance**. Translation/OCR quality and reading order still need broader evaluation too; layout work cannot correct a bad translation. Torii is a useful visual comparator, not an answer key.

R7 matters because the editor must show the same cleaned page you export. Cleanup should be a separate editable layer: moving English text must not move the erased Japanese underneath it. M7 then addresses readable English in narrow balloons, whitespace, padding, collisions and typography. Keep the named fitting cases sample697–sample700 and sample76 in that acceptance set.

I would not switch to a larger local generative model on this CPU as a presumed speed fix. I would also not promise that removing one CTD pass is enough. If the measured result remains too slow, the next decision is a bounded detector/region-routing optimization or explicit quality/latency trade-off—not more invisible fallback paths.

## Could an image generator make the inpainted masks?

**Yes for generating a cleaned background patch; not a proven replacement for precise text masks.**

A mask is just the selection of pixels allowed to change. The inpainted patch is the new image content. Specialised services such as FLUX.1 Fill accept an image plus a mask; they do not remove the need to select what may change. [BFL Fill documentation](https://docs.bfl.ai/flux_1_fill).

A general image editor could be asked to remove lettering without a supplied mask. That is technically worth testing, but it may alter art, miss text, or remove sound effects we intended to preserve. Differencing its answer against the original would detect all changes, not magically identify a trustworthy text-only mask.

Most importantly: **if we keep today's CTD masks and only replace the five-second reconstruction, we have not solved the seventeen-minute detector bottleneck.**

For fidelity, use cropped regions with surrounding context, align the result back to source resolution, and composite it only through an approved mask. Keep the original outside that mask exactly unchanged. This protects the rest of the page; it does not prove that generated artwork inside the mask is correct.

OpenAI documents that masked edits may not follow the mask exactly, complex requests can take up to two minutes, and input/output filtering applies. Whole-page edits also introduce resolution/alignment risks. Content filtering matters for this corpus: a cloud provider may reject pages even when the requested operation is only cleanup. It cannot be assumed to cover every page. [OpenAI image-generation guide](https://developers.openai.com/api/docs/guides/image-generation).

### What would it cost?

Official prices checked 2026-09-21, USD. These are API prices, not a subscription allowance or measured costs for our crops.

| Example | Published price | Important qualification |
| --- | --- | --- |
| FLUX.1 Fill [pro] | $0.05 per image | Specialised masked editing; previous-generation offering. [BFL pricing](https://docs.bfl.ai/quick_start/pricing). |
| GPT Image 1.5 | $0.034 for a medium-quality 1024×1024 output; $0.133 at high quality | Image/text input charges are additional; other sizes cost differently. This is a concrete older-model price example, not a best-model recommendation. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-image-1.5). |
| GPT Image 2.5 Flare | $8 / million image-input tokens, $30 / million image-output tokens; $5 / million text-input tokens | Per-edit cost depends on actual usage, dimensions and settings. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare). |

For Flare, a **hypothetical** 2,000 image-input tokens + 2,000 image-output tokens + 200 text-input tokens costs $0.077. That is arithmetic illustrating the tariff, not a prediction that our crop will use those token counts.

At the simple **$0.05 per call** example:

| Usage assumption | 260 pages | 1,000 pages |
| --- | ---: | ---: |
| One generated edit on every page | $13 | $50 |
| Ten crop edits on every page | $130 | $500 |
| Only 5% of pages need help, two crop edits each | $1.30 | $5 |

These scenarios exclude retries, taxes and the existing OCR/translation/QA bill. A single page-sized request is not proven to retain enough detail or succeed on all regions. Crop calls multiply rapidly. Token-billed providers need their actual input/output charges added rather than borrowing the flat-price assumption.

**My recommendation:** potentially economical as an optional exception tool; not yet justified as the default cleanup engine. Success rate matters more than sticker price: measure cost and time per *accepted* patch, including failures and review.

A later, separately approved experiment could use ten permitted, non-sensitive crops, one selected provider/model, one attempt each, and a $3 hard total cap including input charges. Compare against existing local cleanup for text removal, artwork preservation, screentones, latency, failures and billed cost. Stop at the cap; do not upload disallowed content or work around provider filters. No such experiment was run or paid for in this review.

## The decision to sleep on

Keep the rewrite, but narrow the next delivery.

**Reliable sequential cleanup → honest speed/quality measurement → matching editor → readable fitting.**

The generator idea is a plausible later quality tool, not evidence that today's bottleneck is solved. Tomorrow's task is to finish and test one coherent piece of the existing pipeline—not to choose another architecture.
