# Runbook — regenerate 150 corpus pages, then benchmark free translation models

**Written:** 2026-08-27 · **For:** Gemini via antigravity CLI
**Replaces:** `docs/gemini-erasure-eval-runbook.md` (deleted — wrong task; the erasure-eval runs stay
with Claude, see `docs/RESUME_2026-08-28.md`)

You are refreshing 150 corpus pages through two pipelines and then running a translation benchmark
on the result. **Do not redesign the corpus schema, do not edit the results docs, do not commit.**
Report what happened, including failures, verbatim.

---

## ⚠️ Corrections — read these before following anything below

This runbook was written 2026-08-27. `docs/PLAN_corpus-regen-on-chrome-box_2026-08-28.md`
supersedes it on four points, verified against the live deployment. **Where the two disagree, the
plan wins.** The commands you were dispatched with already encode these corrections — do not
"fix" them back toward the prose below.

1. **The app arm is 121 pages, not 150.** JP's 59 `samples/ja` pages already carry
   `gpt-5.6-luna` exports that are model-matched to the Torii arm, so they need the **Torii arm
   alone**. Only the 24 new JP pairs go through the app. §2's "the JP pages need re-running" is
   **reversed** — do not force them through OCR.

2. **Do not read the TL/QA model from `metadataJson.model`.** That field was stamped from the
   worker's static default, not the model that ran. It is fixed on the box as of 2026-08-28, so it
   is correct for pages **you** generate — but every pre-existing `corpus/samples/` page still
   carries `deepseek/deepseek-v4-pro` while `gpt-5.6-luna` actually translated it. Always take the
   model from **`tl.cost.breakdown[].model`**, which was right all along.

3. **Budget ~7–10 h for the app arm at `--app-shards 2`, not 4–6.** Measured 5.5 min/page on the
   deployed box. This is an overnight run; it has not hung.

4. **Exclude SFX regions from the scoring set.** Torii translates SFX by instruction; our policy is
   that SFX are never typeset. Scored naively, that measures the policy, not the pipeline.


## Why this run exists — the number that matters

Torii charges **$6 for 2,500 translations** — **$0.0024 per page**. Running the same pages through
our own stack currently costs *more* than that. The whole point of this exercise is to find out
whether a free model can hold quality at that price, so **cost per page is a first-class result
here, not a footnote.** Record token counts and cost for every model you bench, even the free ones
(a free model that needs three retries is not free in wall-clock or rate-limit budget).

---

## Artifacts: keep everything, not just the final image

Both arms cost real money — Torii per call, our own app in paid LLM translation. **"It produced the
render" is not success.** If the intermediates were dropped, the only way back is to pay again.

Three fixes landed on 2026-08-27 before this run was allowed to start:

1. **`fetch_torii.py` now saves the raw API response *first*.** It used to derive every artifact —
   decode base64, write PNGs, zip a bundle — and only then persist `torii_response.json`. Any
   failure in that derivation (bad field, full disk, permissions) lost a paid response with nothing
   on disk. Now the response and a new `torii_call.json` (translator, **credits remaining**,
   timestamp) are written immediately, and derivation happens after.
2. **`fetch_torii.py --rederive`** rebuilds every artifact from a saved `torii_response.json` with
   **no API call and no spend.** This is the recovery path — if a sample looks incomplete, try this
   before ever re-calling.
3. **`export_pending.cjs` no longer deletes `project.zip`.** It unpacked the zip to `project/` and
   then `unlink`ed it. That contradicted the corpus's own convention — `corpus/.gitignore:52`
   ignores `samples/**/project.zip` precisely because it "is present locally and absent in a fresh
   clone" — and threw away an artifact that costs a full pipeline run to reproduce.

`regen_run.py` verifies both arms against an explicit artifact list after every run and prints
what is missing per sample. Running it against the one pre-existing sample proved both bugs:
sample264 was missing `project.zip` and had no record of what the call cost.

**Expected after the torii arm:** `ref-torii.*`, `torii_response.json`, `torii_call.json`,
`torii/metadata.json`, `torii/images/0_inpainted`, `0_original`, `0_translated`, `torii/bundle.torii`.
**Expected after the app arm:** `export.png`, `project.zip`, `project/project.json`, `render.png`.

If the completeness report lists anything, **do not silently re-run the paid call** — report it.

---

## 0. Environment

```bash
cd /home/sagnik/Projects/docker-composes/manga-library
```

- Python deps are installed system-wide — **do not create a venv, do not pip install.**
- `fetch_torii.py` reads its key from `secrets/api_keys.json` if `TORII_API_KEY` is unset.
  `export_pending.cjs` needs `TLHUB_EMAIL`, `TLHUB_PASSWORD`, `TLHUB_BASE` and a running stack
  (`docker compose up`). The export account needs **TRANSLATOR** at minimum; **ADMIN** additionally
  lets it delete the scratch series rather than leaving an empty one.
- Playwright is not a repo dependency: `npm i -D playwright && npx playwright install chromium`.
- Torii API limits: **1 req/sec steady**, burst 100; 50 MB / 100k px side / 100 MP per file.
  Respect the 1/sec — do not parallelise the Torii arm.

---

## 1. The page set — read this before selecting anything

The ask was "50 each of JP, KR, ZH → EN with human references". **Two thirds of that comes straight
from `gaps/pending/`; the JP third does not exist there, and the reason matters.**

`corpus/gaps/scraped_tweets_pairs/MANIFEST.json` has 1,058 entries forming **529 complete pair
groups**:

| lang_pair | complete groups | usable for JP/KR/ZH → EN? |
|---|---|---|
| `kr-en` | 202 | **yes** — Korean source, human English |
| `zh-en` | 159 | **yes** — Chinese source, human English |
| `jp-kr` | 168 | **no** — the Japanese pages are paired with **Korean**, not English |

There is **no `jp-en` set**. Do not try to build one from `jp-kr`; the target language is wrong.

### Where each 50 comes from

| | source | available | already done | what this run must do |
|---|---|---|---|---|
| **ko** | `corpus/gaps/pending/ko/` | 192 | 1 | Torii **and** our app |
| **zh** | `corpus/gaps/pending/zh/` | 159 | 2 (our app only) | Torii **and** our app |
| **ja** | `gaps/pending/ja/` (**new**, from `jp_en_pairs.zip`) + `corpus/samples/ja/` with `ref-human` | see below | — | Torii **and** our app |

Every pending ko/zh sample already carries `ref-human` with `attribution` pointing at the source
tweet — that is the ground truth, and it is why this set is worth the spend.

### The JP set needed building first — `corpus/scripts/ingest_jp_pairs.py`

`jp_en_pairs.zip` is **not shaped like the kr/zh sets** and could not be ingested the same way. Its
MANIFEST has no `role` and no `pair_group`; `source_text_jp` is empty on all 127 entries; and the
three obvious shortcuts are all wrong:

- *"two images in one tweet = a pair"* — no. Those are usually **the same Japanese page reposted by
  two handles** (pair009/pair029).
- *"the tweet text says which it is"* — no. pair062's tweet says "Eng ver" and the image is
  Japanese; pair047's says "英語版です!" and the image is English.
- *"`pairNNN_` is a pair id"* — no. pair001 and pair031 are the same two images.

So both halves are recovered from pixels: **pairing** by 32×32 layout signature (washes out text,
keeps composition; correlation > 0.80 with matching aspect), then **which side is Japanese** by
PaddleOCR CJK-character ratio, run only on images that made it into a pair. That yields **117 unique
images → ~36 candidate pairs**, which lands JP short of 50 on its own — so JP is topped up from the
**58 `corpus/samples/ja` pages that carry `ref-human`**. Report how many you actually got.

```bash
python3 corpus/scripts/ingest_jp_pairs.py --dry-run     # report pairs, write nothing
python3 corpus/scripts/ingest_jp_pairs.py               # writes gaps/pending/ja/sample615+
```

Note `enable_mkldnn=False` inside that script is load-bearing — the default oneDNN path raises
`ConvertPirAttribute2RuntimeAttribute not support` on this box and kills the process.

**There is now a driver for all of this — use it rather than hand-rolling loops:**

```bash
# see what would run, touch nothing
python3 corpus/scripts/regen_run.py \
  --targets pending/ja pending/ko pending/zh samples/ja-human --limit 50 --dry-run
```

`corpus/scripts/regen_run.py` resolves the targets, skips anything already done, runs the Torii arm
in parallel behind a 1 req/sec token bucket, then runs the app arm, and records per-sample status in
`corpus/gaps/pending/.regen_state.json` so it is safe to interrupt and re-run.

---

## 2. Our-app arm — `export_pending.cjs`  (~7-10 h at `--app-shards 2`, run first)

This uploads the source, waits for the full async pipeline (OCR → inpaint → LLM translation → QA),
then captures `export.png`, `project.zip` (unpacked to `project/`) and `render.png`.

```bash
TLHUB_EMAIL=... TLHUB_PASSWORD=... TLHUB_BASE=http://localhost:8084/tlhub \
  node scripts/playwright/export_pending.cjs --pending-dir corpus/gaps/pending/ko/sample265
```

Loop it over each id in your list, **one at a time**. It already picks reading direction and OCR
model from language and page dimensions (ko → PP-OCRv5, ja/zh → PP-OCRv6; aspect ≥ 2.0 → webtoon
left-to-right) and uses OpenRouter GPT-5.6 Luna for translation to match Torii. **Do not override
those** — model-matching is deliberate.

### Scratch containers — the library does not get flooded any more

Reworked 2026-08-28. It used to create **one chapter per sample** (`pending-sample264`), so a
150-page run left 150 chapters burying the real library. Now every upload goes through throwaway
`__scratch__` containers that are reused and then deleted.

It is not always literally one series and one chapter, and the reason is the data model:
`readingDirection` is a **series** field while the OCR/TL model choice is a **chapter** field. So
the minimum is one scratch series per (language, direction) and one chapter per model config inside
it — a single-language run genuinely is one and one; a mixed ja/ko/zh run is three and three.
Scratch containers are also found and reused *across* runs, so an interrupted run leaves the same
handful rather than a fresh orphan each time.

Cleanup order: each page is deleted as soon as its artifacts are on disk (`DELETE /api/pages/{id}`
drops the MinIO objects too), then chapters, then series — inside a `finally`, so a crashed run
still tidies up. **Deleting a series is ADMIN-only**; a TRANSLATOR account gets 403 there and leaves
an empty scratch series behind, which the next run reuses. That is expected, not a failure.

One coupling worth knowing before you touch it: `uploadSource` posts `pageNumber: 1`, so **deleting
each page is load-bearing** for a shared chapter, not just tidiness — two samples uploaded as page 1
would collide. `--keep-pages` deliberately breaks that invariant and switches to sequential
numbering instead. `--keep-scratch` leaves the containers for inspection.

### ~~The JP pages need re-running, not just re-exporting~~ — REVERSED, see correction 1

All 58 JP samples already have an `export.png` and a `project/`. **54 of them are stale** and must
go through OCR again. The test is the minimum `layers[].metadataJson.time` in `project.json` against
the deployed worker's build time:

```bash
docker image inspect ghcr.io/sagnikdas53/manga-tl-worker:latest --format '{{.Created}}'
# built 2026-08-24T22:08:29+05:30 as of writing — re-derive it, do not hardcode
```

OCR timestamps on those 58 run 2026-08-13 → 2026-08-26; only sample241, sample258, sample262 and
sample263 are newer than the image. **Balloon geometry and masks are decided at OCR time and baked
into the project, so re-rendering a stale page does not fix it** — it has to go through OCR again.
Treat every JP page except those four as needing a full re-run.

**Record:** for each page, success/failure, wall-clock, and the TL + QA model and cost from
`project.json`'s **`metadataJson.tl.cost.breakdown[].model`** — *not* `metadataJson.model`, see
correction 2. Any page that fails, leave as it is and note it — do not retry more
than twice, and do not hand-edit a project.

---

## 3. Torii arm — `fetch_torii.py`  (~30 min for 150, plus the sweep)

```bash
python3 corpus/scripts/fetch_torii.py --sample gaps/pending/ko/sample265
```

The key is resolved in this order: `--api-key`, then `$TORII_API_KEY` / `$TORII_KEY`, then
**`secrets/api_keys.json`** (gitignored, holds the live keys). So a rotated key is picked up without
re-exporting anything. There is no hardcoded fallback — it fails loudly instead.

It adds `ref-torii.<ext>`, a `torii/` bundle (original / inpainted / translated + metadata) and a
`torii_response.json`, and updates `meta.json`. It does **not** replace existing
`ref-mangatranslator.ai` refs.

**Sanity-check on one page with `--dry-run` first.** Then run all 150 at 1 req/sec.

### Then the model comparison — 30 pages, 2 extra translators

Default translator is `gemini-3.1-flash-lite`. Pick **30 pages spanning all three languages**
(10 each) and re-run them under two more of Torii's translators, saving to a separate output so the
main `ref-torii` is not overwritten — `fetch_torii.py` writes `ref-torii-2` when one already exists,
and `--out` redirects to an explicit path.

**Budget:** 150 + 60 = **210 calls ≈ 8 % of the 2,500 quota.** Confirm the remaining balance before
and after and report both.

**Record:** which translators Torii actually exposes, per-page latency, and any refusals or errors.
If a translator is not available on the subscribed tier, say so rather than substituting one.

---

## 3b. Model matching — the benchmark was invalid without this

**The two arms were on different models.** `fetch_torii.py` defaulted to `gemini-3.1-flash-lite`
while `export_pending.cjs` defaulted to `openai/gpt-5.6-luna`. Any quality difference measured that
way is **the model, not the pipeline**, which is the one thing this benchmark must not confound.

There is now a single flag that sets both, and a mismatch is a hard error:

```bash
python3 corpus/scripts/regen_run.py --targets pending/ja pending/ko pending/zh \
  --limit 50 --model gpt-5.6-luna
# model: gpt-5.6-luna  ->  torii translator=gpt-5.6-luna  app=openrouter:openai/gpt-5.6-luna
```

`MODEL_MAP` in `regen_run.py` holds the pairings. It deliberately contains **only entries with a
source** — `gemini-3.1-flash-lite` is Torii's documented default, `gpt-5.6-luna` is the pairing this
repo already encoded. **Torii's full translator catalogue is not in the API PDF** (it is a dropdown
on their API page), so before benchmarking a third model, read the exact translator string off that
dropdown and add it to the table. Do not guess: an unrecognised translator string risks silently
falling back to their default, which re-creates the mismatch.

`--torii-translator` / `--app-model` override individual sides and will refuse to run unless you
also pass `--allow-model-mismatch` — which is only meaningful when you are deliberately measuring
the model rather than the pipeline.

## 3c. BYOK — yes, Torii supports it, and it is worth using

Confirmed in `corpus/docs/tori/Image Translation and OCR API _ Torii Image Translator.pdf`. Torii
accepts a Bring-Your-Own-Key header: `x-byok-openrouter`, `x-byok-openai`, `x-byok-google`,
`x-byok-anthropic`, `x-byok-deepseek`, `x-byok-xai`, `x-byok-local` (with `x-byok-local-url` for a
self-hosted OpenAI-compatible endpoint).

```bash
python3 corpus/scripts/regen_run.py --targets pending/ko --limit 50 \
  --model gpt-5.6-luna --byok openrouter
```

Three things it buys, and they compound:

1. **Their prompts become visible.** With the call billed to our OpenRouter account, OpenRouter's
   own request logging records what Torii actually sends — the system prompt, the batching, the
   context format. That is the highest-value reverse-engineering artifact available here and it
   costs nothing extra to collect. **Turn on request logging in the OpenRouter dashboard before
   the run, or the calls pass through unrecorded.**
2. **Torii's cost collapses to a flat 1 credit per image** — their docs: *"Image translation will be
   reduced to 1 credit (OCR/server costs), no matter text length or model chosen"*. The LLM cost
   moves onto our OpenRouter bill instead, which is the side we are trying to measure anyway.
3. **It removes all doubt about which model ran**, since we can see the request.

The key is read from `--byok-key`, then `$OPENROUTER_API_KEY`, then `secrets/api_keys.json`.

**Caveat worth stating in the report:** a BYOK run and a credits run are not identical conditions.
Record which mode each sample used — `torii_call.json` now carries a `byok` field — and do not mix
the two within one comparison.

## 3d. `bubbles_only` — the documented flag behind their bubbles-first behaviour

The same PDF documents `bubbles_only`: *"only text inside detected speech bubbles will be
translated, and also text that is very long and high-confidence, even if not inside a bubble."*
That is a direct answer to the "do they do bubbles first and SFX only sometimes?" question — it is
a request flag, not an inference. Exposed as `--bubbles-only` on both `fetch_torii.py` and
`regen_run.py`.

Two further parameters are now plumbed through and worth knowing about, both undocumented in our
own notes until today: `custom_prompt` (max 1000 chars) and `context` (max 10000 chars, a **context
chain** — pass `"None"` on the first image, then feed each response's `context` back into the next
page to carry names and terminology forward). We do not use context chaining yet; our own pipeline
has `useContextMemory`, so a like-for-like run should probably enable both or neither.

## 4. Build the translation corpus

```bash
python3 scripts/build_translation_corpus.py --examples-dir corpus/samples --out-dir corpus/translation
python3 scripts/build_translation_corpus.py --list-eligible    # check the count first
```

This runs local PaddleOCR over source and reference, merges fragments with the worker's own
`merge_ocr_regions`, and nearest-centroid matches source regions to reference regions. It prefers a
**human** reference over a machine one, which is exactly what we want here.

Two cautions from the script's own docstring, worth repeating because they bound the conclusions:
every auto region is tagged `regionType: "speech"` (OCR cannot tell sign/sfx/caption apart), and
alignment can be wrong where a reference reflows text into different bubble positions.

**Note:** the pending ko/zh pages live under `corpus/gaps/pending/`, not `corpus/samples/`. Either
promote them first with `corpus/scripts/promote_drops.py`, or point `--examples-dir` at the pending
tree — **say in your report which you did**, because it changes the ids.

---

## 5. The benchmark

```bash
python3 scripts/benchmark_translation.py --free-only --corpus-subset all
python3 scripts/benchmark_translation.py --provider openrouter --free-only
python3 scripts/benchmark_translation.py --provider nvidia --free-only
python3 scripts/benchmark_translation.py --provider neurometric --free-only
```

Providers are `openrouter`, `nvidia`, `neurometric` and `local` (`config/providers.json`).
Cloudflare was removed and is not a target. **Free tier only** — paid comes later.

The candidate pool matters: `config/providers.json` is the narrow production list, while
`scripts/test-providers.json` is the wide unvetted pool (107 free `tl` entries as of 2026-08-07).
Free-tier membership churns, so **re-verify against each provider's live model list** before
trusting the committed snapshot, and say in your report when you pulled it.

The runner tries `json_schema` → `json_object` → prompt-only in order and records which worked —
that column is a real result, not noise. A model that only manages prompt-only JSON is a different
integration cost from one that does strict schema.

**Record, per model:** quality score against the human reference, structured-output mode achieved,
failure/retry rate, tokens in/out, and **cost per page** — then rank against Torii's **$0.0024**.

---

## What to hand back

`docs/gemini-run-report-2026-08-27.md`, one section per stage:

- exact commands run
- full stdout in fenced blocks (truncate long loops to first/last 20 lines plus a count)
- counts: pages attempted / succeeded / failed, per language
- Torii quota before and after
- the benchmark table, sorted by cost per page, with the Torii line drawn on it
- everything that failed, verbatim

**Do not** edit `docs/ctd_mask_validation_2026-08-26.md`, `docs/erasure_overhaul_plan_2026-08-26.md`,
`docs/RESUME_2026-08-28.md` or any file under `corpus/gaps/manga-tl-erasure-eval/`. Do not commit.
