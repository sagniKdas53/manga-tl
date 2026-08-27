# Runbook — regenerate 150 corpus pages, then benchmark free translation models

**Written:** 2026-08-27 · **For:** Gemini via antigravity CLI
**Replaces:** `docs/gemini-erasure-eval-runbook.md` (deleted — wrong task; the erasure-eval runs stay
with Claude, see `docs/RESUME_2026-08-28.md`)

You are refreshing 150 corpus pages through two pipelines and then running a translation benchmark
on the result. **Do not redesign the corpus schema, do not edit the results docs, do not commit.**
Report what happened, including failures, verbatim.

---

## Why this run exists — the number that matters

Torii charges **$6 for 2,500 translations** — **$0.0024 per page**. Running the same pages through
our own stack currently costs *more* than that. The whole point of this exercise is to find out
whether a free model can hold quality at that price, so **cost per page is a first-class result
here, not a footnote.** Record token counts and cost for every model you bench, even the free ones
(a free model that needs three retries is not free in wall-clock or rate-limit budget).

---

## 0. Environment

```bash
cd /home/sagnik/Projects/docker-composes/manga-library
```

- Python deps are installed system-wide — **do not create a venv, do not pip install.**
- `fetch_torii.py` needs `TORII_API_KEY`. `export_pending.cjs` needs `TLHUB_EMAIL`,
  `TLHUB_PASSWORD`, `TLHUB_BASE` and a running stack (`docker compose up`).
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
| **ja** | `corpus/samples/ja/` **with `ref-human`** | **58** | 2 have Torii | Torii **and** re-run our app |

Every pending ko/zh sample already carries `ref-human` with `attribution` pointing at the source
tweet — that is the ground truth, and it is why this set is worth the spend.

**The JP margin is thin: 58 candidates for 50 slots.** Take all 58 if any fail, and say in your
report how many you actually got. Do not substitute JP pages that have no `ref-human`.

Generate the three lists first and save them, so the run is reproducible:

```bash
python3 - <<'PY' > /tmp/regen_list.json
import os, json
out={}
for lang, base in (("ko","corpus/gaps/pending/ko"), ("zh","corpus/gaps/pending/zh")):
    out[lang]=sorted(s for s in os.listdir(base)
                     if os.path.isdir(os.path.join(base,s))
                     and any(f.startswith("ref-human") for f in os.listdir(os.path.join(base,s))))[:50]
base="corpus/samples/ja"
out["ja"]=sorted(s for s in os.listdir(base)
                 if os.path.isdir(os.path.join(base,s))
                 and any(f.startswith("ref-human") for f in os.listdir(os.path.join(base,s))))[:50]
json.dump(out, open("/dev/stdout","w"), indent=1)
PY
cat /tmp/regen_list.json
```

---

## 2. Our-app arm — `export_pending.cjs`  (~4-6 h, run first)

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

### The JP pages need re-running, not just re-exporting

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
`project.json`'s `metadataJson`. Any page that fails, leave as it is and note it — do not retry more
than twice, and do not hand-edit a project.

---

## 3. Torii arm — `fetch_torii.py`  (~30 min for 150, plus the sweep)

```bash
TORII_API_KEY=sk_torii_... python3 corpus/scripts/fetch_torii.py --sample gaps/pending/ko/sample265
```

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
