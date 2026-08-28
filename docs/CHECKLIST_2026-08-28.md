# Checklist — 2026-08-28

Single top-level to-do across all threads. Deeper detail lives in the docs each item points at.
Legend: **[you]** only you can do it · **[gemini]** delegated grunt work · **[claude]** my next work.

---

## 0. Before anything spends money

- [x] **[you] Turn on request logging in the OpenRouter dashboard.** Without it the BYOK run passes
      through unrecorded and the prompt-capture opportunity is lost — and it is not repeatable for
      free. This is the single highest-value five minutes on the list.
      User Answer: Done, logging is on.
- [x] **[you] Read Torii's translator dropdown** at `toriitranslate.com/api` and paste the exact
      strings. Their catalogue is **not** in the API PDF. `MODEL_MAP` in `corpus/scripts/regen_run.py`
      currently has only two verified entries; a guessed translator string risks silently falling
      back to their default and re-creating the model mismatch the map exists to prevent.
      User Answer: [API is public](https://toriitranslate.com/api), models are ![alt text](image.png)
- [x] **[you] Decide the export account's role.** `DELETE /api/series/{id}` is ADMIN-only. With
      TRANSLATOR the run leaves one empty `__scratch__` series per (lang, direction) — harmless and
      reused next run, but it will not fully clean up.
      User Answer: Use TRANSLATOR if you want to avoid the risk of a mistaken delete, and leave the iamges as well since we translate them anyway, what if we need them again?
- [x] **[you] Confirm the Torii credit balance** before and after; the plan is ~210 calls of 2,500,
      and BYOK drops that to 1 credit/image.
      User Answer: It's 2495 remaining credits, so we have enough for the run. The BYOK will drop it to 1 credit/image for OCR + inpainting as TL happens with our key so we can easily do what we wanted.

## 1. The regeneration run — `docs/gemini-corpus-regen-runbook.md`

- [ ] **[gemini] Smoke-test one sample end to end** with `--limit 1` before the batch, and check the
      artifact completeness report is clean. Both fixes (save-response-first, keep `project.zip`)
      are untested against the live API — I could only verify them statically.
- [ ] **[gemini] Run the 150.** 50 ja / 50 ko / 50 zh, model-matched, BYOK on:
      ```
      python3 corpus/scripts/regen_run.py --targets pending/ja pending/ko pending/zh \
        --limit 50 --model gpt-5.6-luna --byok openrouter
      ```
- [ ] **[gemini] Torii model comparison** — 2–3 translators on a 30-page subset (10 per language),
      once the catalogue from item 0 is known.
- [ ] **[gemini] Build the translation corpus** — `build_translation_corpus.py`. Note the pending
      pages are under `gaps/pending/`, not `samples/`; say which path you used, it changes the ids.
- [ ] **[gemini] Run the free-model benchmark** — openrouter, nvidia, neurometric, free tier only.
      Rank by **cost per page against Torii's $0.0024**, which is the actual question.
- [ ] **[gemini] Report** to `docs/gemini-run-report-2026-08-27.md`, including failures verbatim.

## 2. Erasure / masking — not delegated

- [ ] **[claude] Fix the mask overlap bug.** 52 % of pages have overlapping element polygons; the
      later one paints over the earlier one's sampled backdrop. Small area (median 1.0 %) but it is
      a correctness bug and is cheap. Independent of everything else.
- [ ] **[claude] `sweep.py` at `CTD_THREADS=2`** — input-size sweep 512–1024. The most valuable open
      measurement, because Finding 6 left the latency gate unmet and input size is the cheapest lever.
- [ ] **[claude] `crop2.py` over the remaining 18 pages** — confirm the gate result generalises
      beyond sample106/136/47.
- [ ] **[claude] Measure recall recovery.** Finding 7's new scope: threshold 0.5 → 0.3 is already
      measured and worth doing, but only fixes the polarity half; then dilation inside the region
      set, then a second pass where residual ink is detected.
- [ ] **[claude] Explain sample93 / sample128 / sample136** — the dense-text-over-artwork family,
      41–56 % recall. `an/miss136.png` exists; the other two need the same diagnostic.
- [ ] **[claude] Test reducing `PAD` from 64** in the crop path — largest single term in crop area,
      never tuned.
- [ ] **[claude] `sheet.py` / `demo.py` / `spot.py`** — contact sheet, plate comparison, spot checks.
- [ ] **[claude] Answer the second Torii question** once the run has produced more bundles: is their
      plate *reconstructed artwork* or a *smoothed approximation*? Needs a visual read under a few
      balloons, not a statistic. Determines whether step 3 of the mask plan is inpainting or
      something cheaper. See `docs/mask_precision_2026-08-27.md` §4.

## 3. Decisions waiting on you

- [x] **[you] Bubbles-first / SFX policy.** Your 2026-08-13 decision was **SFX are never typeset**.
      Torii's `bubbles_only` flag does it by *length + detector confidence*, not SFX classification.
      Adopting that is a real reversal of a recorded decision — worth making deliberately. It is now
      measurable directly via `--bubbles-only`.
      User Answer: We will keep the SFX policy as is, we will not use the bubbles_only flag since it is not clear how it works they detect SFX if during investiagtion new facts come up we will revisit the decision.
- [x] **[you] Context chaining.** Torii supports a `context` chain; our pipeline has
      `useContextMemory`. We currently run **neither** on the Torii side and **ours enabled** on our
      side, which is one more thing that would skew the comparison. Enable both or neither.
      User Answer: Disabled both, we will not use context chaining for now, since it is not clear how it works and we want to keep the comparison fair.
- [x] **[you] `LICENSE` file.** GPL-3.0 was decided; the repo still has no LICENSE. Also decide
      whether it covers the whole monorepo or just the worker.
      User Answer: Save for later, we will add a LICENSE file to the repo, but for now it is not urgent since the repo is personal and we are not distributing it yet.

## 4. Risks and loose ends

- [x] **[you] The revoked Torii key is still in corpus git history** at commit `0ca0e00`, on
      `origin/main`. The repo is **private** and the key is revoked, so this is not urgent — but it
      is also in `corpus/docs/tori/…API….pdf`, which is where it came from. Scrubbing needs a
      history rewrite and force-push; I have not touched it.
      User Answer: We will not scrub the history for now, since the repo is private and the key is revoked, but we will keep it in mind for future if we decide to make the repo public.
- [x] **[you] The git index is partially staged** across both repos and nothing is committed. I left
      it as found rather than resetting. ~60 files including the new scripts and eval artifacts.
      User Answer: We will commit the changes to the repo, since it is not urgent but we want to keep track of the changes.
- [x] **[claude/you] Samples exported by the *old* script are missing `project.zip`** — it used to
      delete it. They will be skipped as "already exported" unless forced. `regen_run.py`'s
      completeness report flags them; decide per sample rather than blanket re-running (it costs
      paid translation).
      User Answer: Lets regenerate all samples using Torii and our updated rust backend, since the old script is missing project.zip and we want to have a complete set of samples. This will allow us to get a fresh start and avoid any issues with missing files. Also will make is easier to compare the results of the new run with the old one, since we will have a complete set of samples. Organization would also be easier since we will have a clean slate and can organize the samples in a more logical way. We will also be able to compare the results of the new run with the old one, since we will have a complete set of samples. This will allow us to see if there are any improvements or regressions in the translation quality, and make any necessary adjustments to our pipeline. Overall, this will give us a fresh start and allow us to move forward with our translation efforts in a more organized and efficient manner.
- [x] **[optional] The 4 rejected JP pairs.** Three are genuine English-English reposts with no
      Japanese side — not recoverable. One (`chars 0/33`) may be a resolution miss; raising
      `OCR_MAX` in `ingest_jp_pairs.py` would settle it. Low value: 24 pairs plus 58 `samples/ja`
      already covers the 50 needed.
      User Answer: We will not re-run the rejected JP pairs, as they are not recoverable and the value is low.

---

## Verified state as of writing

| | |
|---|---|
| ja pending | 24 (new, from `jp_en_pairs.zip`) + 58 `samples/ja` with `ref-human` |
| ko pending | 191 available, 1 done |
| zh pending | 157 available, 2 part-done |
| Torii key | revoked and rotated; resolved from `secrets/api_keys.json` |
| Model matching | enforced; mismatch is a hard error |
| Artifact completeness | verified per arm after every run |
| Committed | **nothing** |
