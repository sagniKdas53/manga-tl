# Plan — run the corpus regeneration against the temporary `chrome-box` instance

**Date:** 2026-08-28 · **Status:** **ready to dispatch** — A, B, D closed; see §0
**Context:** the stack is deployed and healthy on chrome-box; it is a **disposable test instance**
and comes down once the corpus is regenerated. Everything below is ordered by that fact.
**Follows on from:** `docs/CHECKLIST_2026-08-28.md`, `docs/gemini-corpus-regen-runbook.md`,
`docs/PLAN_rust-merge-and-remote-deploy_2026-08-28.md`

---

## 0. Status — what changed after the first pass

| item | state |
|---|---|
| **A** watchtower | **done.** `docker-compose.chrome-box.yml` written on the box; both containers recreated; `manga-backend` and `manga-worker` now report `watchtower.enable=false` |
| **B** wrong TL model | **fixed, deployed, verified on the box.** A translation redo on the test page now records `openrouter/openai/gpt-5.6-luna` on all 7 regions, where it previously recorded `openrouter/deepseek/deepseek-v4-pro` |
| **C** JP staleness | stands: 57 of 59 stale against the deployed worker |
| **D** >2 MB gate | **closed by you** — a ~30 MB page went through cleanly on `ideapad`. Dropped from the critical path |
| **E** SFX policy divergence | stands: exclude SFX regions from scoring |
| scope | **150 pages**, confirmed. `corpus/samples/` is *not* regenerated — see §4.1, which supports that call with evidence |

---

## 1. Verified state of the deployment

All checked against the live box this session, not assumed.

| Check | Result |
|---|---|
| `GET /tlhub/actuator/health` over the tailnet | `200 {"status":"UP"}` |
| Backend | **Rust** — entrypoint is the native `manga-backend` binary, not `java -jar` |
| Repo checkout | `/home/sagnik/Documents/docker-composes/manga-tl`, branch `main` @ `de8d391` |
| Login as `l0rirw1ao@…` | `200`, `role = admin` |
| Chapter `e0dbc017…` | series "Test" (rtl), 1 page, `useContextMemory: false` ✅ |
| Pipeline on that page | OCR ✅ → TL ✅ → QA ✅ (`partial_pass`, 7 regions, 3 pass / 4 direct-fix) |
| Global models | `tl/qa = openrouter openai/gpt-5.6-luna` ✅ matches the Torii arm |
| OpenRouter key | `gpt-5.6-luna` reachable; **$11.04 of $20** monthly limit left |
| Estimated LLM spend | luna ≈ **$0.0011/page** → ~$0.17 for 150 pages. Budget is not a constraint. |

`main` already contains the `rust-backend` merge (PR #91, `c2a69c1`), so the deploy-then-merge
sequencing in the earlier plan is moot — it merged first. That is fine, but see finding **D**.

---

## 2. Five findings that changed how the run should go

*Recorded as found. §0 carries current status; A, B and D are closed.*

### A. Watchtower would have killed the batch tonight — applied

The override in `PLAN_rust-merge-and-remote-deploy_2026-08-28.md` §2.5a **was never applied**:

```
manga-backend: com.centurylinklabs.watchtower.enable = true
manga-worker:  com.centurylinklabs.watchtower.enable = true
chrome-box watchtower: WATCHTOWER_LABEL_ENABLE=true, WATCHTOWER_SCHEDULE=@daily, TZ=Asia/Kolkata
```

`@daily` fires at **00:00 IST**. As of writing that is **under 8 hours away**, and the app arm is
longer than that (§3). It will pull and restart both containers mid-batch, killing in-flight jobs.

**Applied 2026-08-28**; both containers recreated and verified reading `false`. What was run:

```bash
cd /home/sagnik/Documents/docker-composes/manga-tl
cat > docker-compose.chrome-box.yml <<'YAML'
services:
  backend:
    labels: ["com.centurylinklabs.watchtower.enable=false"]
  worker:
    labels: ["com.centurylinklabs.watchtower.enable=false"]
YAML
docker compose -f docker-compose.yml -f docker-compose.chrome-box.yml up -d backend worker
```

If the containers are ever recreated without the `-f docker-compose.chrome-box.yml` flag,
the labels revert to `true` — pass both files, or re-verify.

### B. The recorded TL model is wrong in every artifact — and the run depends on that field

**This is the one that would have silently invalidated the benchmark.**

On the smoke page, the stored translation layer says:

```
metadataJson.model                    = deepseek/deepseek-v4-pro      ← WRONG
metadataJson.tl.cost.breakdown[].model = openai/gpt-5.6-luna          ← CORRECT
metadataJson.qa.cost.breakdown[].model = openai/gpt-5.6-luna          ← CORRECT
```

There was **no fallback**. The worker log shows one attempt, first try, success:

```
[edc34b74] Batch: Trying provider 'openrouter' with model 'openai/gpt-5.6-luna'...
[edc34b74] Provider=openrouter Model=openai/gpt-5.6-luna Time=7.04s
```

The cause is `worker/src/worker/handlers/translation.py:323`:

```python
"modelIdentifier": f"{TL_CONFIG.provider}/{TL_CONFIG.llm_model}",
```

`TL_CONFIG` is the module-level singleton built from env at import (`worker/src/worker/config.py:487`).
The field is stamped from the worker's **static configured default** — never from the per-job
`tlModel` and never from the model that actually served the batch. The worker's env default happens
to be `deepseek-v4-pro`, so that is what gets written, on every region, on every page.
(`ocr.py:1443` builds its identifier from the model actually used — OCR gets provenance right, TL
does not. The string is malformed as provenance anyway: `openrouter/deepseek/deepseek-v4-pro`
double-prefixes the provider.)

Why it matters here: the runbook §2 instructs the operator to *"record the TL + QA model and cost
from `project.json`'s `metadataJson`"* — i.e. exactly the poisoned field. Followed literally, all
150 pages would be recorded as translated by `deepseek-v4-pro` while `gpt-5.6-luna` actually ran.
`regen_run.py`'s hard model-match check does not catch this: it validates the *requested* model,
not what the artifact claims afterwards.

**Fixed 2026-08-28.** `process_translation` now resolves the identifier from the recorded per-call
costs, then the model the job requested, and only then the static default:

```python
job_costs = get_job_costs()
last_call = job_costs[-1] if job_costs else {}
resolved_provider = last_call.get("provider") or job_data.get("tlProvider") or TL_CONFIG.provider
resolved_model = last_call.get("model") or job_data.get("tlModel") or TL_CONFIG.llm_model
model_identifier = f"{resolved_provider}/{resolved_model}"
```

Two regression tests in `tests/test_translation_pipeline.py` cover it — one for the cost-record
path, one for the no-costs fallback — and both were confirmed to **fail** with the old line
restored, so they are not vacuous. Worker gates all green: `ruff check` clean, `ruff format --check`
clean, `pyright` 0 errors, **417 tests passed**. `detect_changes` reports one touched symbol
(`process_translation`) and zero affected processes.

Known limitation, documented in the code: when per-region fallback retries fire, several calls are
recorded and the last is attributed to every region. True per-region provenance would mean threading
the model through `resolved_translations`, which is larger scope than this run needs.

**Read the results defensively anyway.** Artifacts produced *before* this fix — which is all of
`corpus/samples/` — still carry the wrong top-level value, so take the model from
`tl.cost.breakdown[].model` when reading anything historical.

### C. The JP staleness list is out of date — 57 stale, not 54

The runbook derived its cutoff from a worker image built `2026-08-24T22:08 +05:30` and concluded
sample241 / 258 / 262 / 263 were fresh. The **deployed** worker image is newer:

```
ghcr.io/sagnikdas53/manga-tl-worker:latest  built 2026-08-25T19:08:38Z
```

Re-derived against the deployed image, over the 59 `corpus/samples/ja` pages carrying `ref-human`:

| | count |
|---|---|
| FRESH — OCR newer than the image, safe to skip | **2** (`sample262`, `sample263`) |
| STALE — must go through OCR again | **57** (OCR times 2026-08-13 → 2026-08-24) |

sample241 and sample258 have fallen stale since the runbook was written. Balloon geometry and masks
are baked at OCR time, so re-rendering does not fix them — they need a forced full re-run.

### D. The `>2 MB` end-to-end gate — closed

Raised because the chrome-box smoke page is only **580 KB** (1024×1024), so it did not exercise the
one item `rust-backend` merged without: a >2 MB source through the full pipeline.

**Closed 2026-08-28**: a **~30 MB** page ran cleanly on `ideapad`
(`/tlhub/chapters/b576fe4d…/one/reader/2`). The gate is met and is off the critical path. It was
always a regression check rather than a merge gate, since the merge had already happened.

### E. Torii translates SFX by instruction — this bears on a decision you already made

`docs/dropdown.md` shows the BYOK prompt capture **already succeeded**. Torii's system prompt,
recovered verbatim through our OpenRouter log, contains:

> *"If a segment is a sound effect or onomatopoeia, provide the standard English equivalent."*

Also recovered: they batch one page per call, demand
`{"translations": ["1. …", "2. …"]}` with an explicit count check, and pass no context chain.

Your 2026-08-13 policy is **SFX are never typeset**, reaffirmed in checklist §3 with *"if during
investigation new facts come up we will revisit."* This is such a fact — and it is a **policy**
divergence, not a quality one. Scored naively, Torii will "win" every SFX region simply because we
deliberately leave them untypeset. **SFX regions must be excluded from the scoring set**, or the
comparison measures the policy rather than the pipeline. This does not require changing the policy.

---

## 3. Throughput — the number that constrains a temporary box

Measured from the one real page (n=1, small page, so treat as a floor):

```
08:12:38 OCR job created → 08:13:03 OCR done      (25 s)
08:13:05 TL job created  → 08:13:20 TL done       (15 s)
08:14:15 … 08:18:08      QA passes                (~88 s)
                                    wall clock ≈ 5.5 min/page
```

The worker is `cpus: 2.0`, `MAX_HEAVY_SLOTS=1`, `CONCURRENT_JOBS=4`, so OCR is serialized no matter
how many browsers point at it.

| scope | app arm, serial | at `--app-shards 2` |
|---|---|---|
| 150 pages | ≈ **13.7 h** | ≈ 7–10 h |
| all samples (562) | ≈ 51 h | ≈ 26–35 h |

**The runbook's "~4–6 h" for 150 is optimistic** — it predates this measurement, and real corpus
pages are larger than the 580 KB smoke page. Plan for an overnight run, which makes finding **A**
non-negotiable.

The Torii arm is unaffected: 150 calls at 1 req/sec ≈ 3 minutes of API time.

---

## 4. Work remaining, sized

```
                             total  torii done  app done
pending/ja (new JP pairs)       24           0         0
pending/ko                     192           1         1
pending/zh                     159           0         2
samples/ja-human                59           0        59  (57 stale → need --force)
```

To hit 50/50/50: **ja** = 24 new pairs + 26 topped up from `samples/ja-human`; **ko** = 49 more;
**zh** = 48 more. Torii arm is ~150 calls from scratch.

**Torii budget:** 150 + 60 (model comparison) = 210 calls. With BYOK that is **1 credit/image = 210
of 2,495**, and the LLM cost lands on our OpenRouter bill at ~$0.0011/page. Comfortable on both.

### 4.1 Is `corpus/samples/` still good? Yes — and better than assumed

Checked over the 59 `corpus/samples/ja` pages carrying `ref-human`:

| | result |
|---|---|
| translated by | **`openai/gpt-5.6-luna` — all 59.** Already model-matched to the Torii arm |
| attribution recoverable | **59 / 59** carry `tl.cost.breakdown`, so the real model survives despite finding B |
| `metadataJson.model` says | `deepseek/deepseek-v4-pro` on all 59 — uniformly wrong, confirming the bug is long-standing |
| `export.png` / `project/project.json` / `render.png` | present on **all 59** |
| `project.zip` | missing on 20 |

**The missing `project.zip` does not cost a pipeline run.** On the 120 samples that have both,
`project/` is an exact unpack of `project.zip` — identical entry lists, verified on three samples.
The old exporter deleted the archive *after* unpacking it, so the content was never lost; the 20 can
be repacked with a `zip` command. This corrects the premise behind checklist §4, which assumed they
had to be re-run.

**Consequence for the JP arm:** those 59 already have a model-matched app-arm export, so JP does not
need 26 forced re-runs. It needs **Torii only** over the existing pages (1 credit each under BYOK),
paired against exports that already exist — plus the 24 new pairs through both arms. That comfortably
clears 50 and is the cheapest path by a wide margin.

**The one real caveat:** 57 of the 59 were OCR'd by a worker older than the deployed image, and
balloon geometry and masks are baked at OCR time. That is **irrelevant to this run**, which measures
translation quality and cost per page, and **relevant** if these pages are later reused to compare
erasure or typesetting. Worth recording next to the results rather than acting on now.

### The Torii translator catalogue — now verified, not guessed

Checklist item 0 is resolved. Extracted from the live `<select id="translator_select">` on
`toriitranslate.com/api`, so these are exact API values:

| value | label |
|---|---|
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite |
| `gpt-5.6-luna` | GPT-5.6 Luna |
| **`deepseek`** | **DeepSeek V4 Flash** |
| `grok-4.20` | Grok 4.20 |
| `kimi-k2.5` | Kimi K2.5 |
| `gemini-3-flash` | Gemini 3 Flash |
| `gemini-3.7-flash` | Gemini 3.7 Flash |
| `gpt-5.6-terra` | GPT 5.6 Terra |
| `claude-sonnet-5` | Claude Sonnet 5 |
| `gpt-5.6-sol` | GPT 5.6 Sol |
| `claude-opus-5` | Claude Opus 5 |

Note `deepseek` — the value is **not** `deepseek-v4-flash`. The runbook's "do not guess" rule was
correct and would have been violated by the obvious inference. All 11 are BYOK-eligible.

`MODEL_MAP` in `regen_run.py` still holds only two entries; it can now be extended safely. Suggested
third and fourth arms for the comparison, spanning cost tiers with OpenRouter-reachable pairings:
`gemini-3.1-flash-lite` (their default) and `claude-sonnet-5` or `gemini-3.7-flash`.

---

## 5. Decisions — taken 2026-08-28

**① Scope: 150 pages.** `corpus/samples/` is not regenerated through the app arm; §4.1 shows those
exports are already `gpt-5.6-luna` and model-matched, so Torii is run over them and they join the
comparison as a second batch. This avoids ~26–35 h of re-running on a box being torn down.

**② Fix finding B before the batch.** Done in source; deployment to the box is the one open step.

---

## 6. Execution order — everything that needs the box, first

The box is disposable, so the ordering principle is: **nothing that can run locally should run
while the box is up.**

### Phase 0 — get the model fix onto the box — **done**

The worker runs from a published image, and chrome-box has no build cache after the earlier
`docker builder prune`, so a rebuild would have reinstalled the heavy PaddleOCR/onnxruntime layers
on two Broadwell cores. The Dockerfile's **last** layer is `COPY src/worker/ ./worker/`, so copying
the single fixed file in is byte-identical to what a rebuild would have produced:

```bash
scp worker/src/worker/handlers/translation.py chrome-box:/tmp/translation.fixed.py
ssh chrome-box '
  docker cp /tmp/translation.fixed.py manga-worker:/app/worker/handlers/translation.py
  docker exec -u root manga-worker chown worker:worker /app/worker/handlers/translation.py
  docker exec -u root manga-worker rm -rf /app/worker/handlers/__pycache__
  docker restart manga-worker'
```

Verified: sha256 inside the container matches the local file; the worker came back healthy with
PaddleOCR seeded and uvicorn up; and a `POST /api/images/{id}/redo?type=translation` on the test
page produced `modelIdentifier: openrouter/openai/gpt-5.6-luna` on all 7 regions.

**The running worker no longer matches any published image — say so in the report.** Recreating the
container from its image reverts the fix, so if anything recreates `manga-worker`, re-apply this
before continuing the batch.

### Phase 1 — on the box, before anything paid (~5 min)
1. ~~Apply the watchtower override~~ — **done**, both labels verified `false`.
2. ~~Close the >2 MB E2E gate~~ — **closed**: a ~30 MB page ran cleanly on `ideapad`.
3. Point the tooling at the tailnet host:
   ```bash
   export TLHUB_BASE='https://chrome-box.tail9ece4.ts.net/tlhub'
   export TLHUB_EMAIL=… TLHUB_PASSWORD=…      # do not commit these
   ```

### Phase 2 — smoke, then the batch (overnight)
4. `regen_run.py --limit 1` end to end; check the artifact completeness report is clean. Both
   2026-08-27 fixes (save-response-first, keep `project.zip`) are still **untested against the live
   API**.
5. The 150, BYOK on, model-matched:
   ```bash
   python3 corpus/scripts/regen_run.py \
     --targets pending/ja pending/ko pending/zh samples/ja-human \
     --limit 50 --model gpt-5.6-luna --byok openrouter --app-shards 2
   ```
   Per the scope decision, JP's app arm is the **24 new pairs only** — the 59 `samples/ja` pages
   already have model-matched exports (§4.1) and need the **Torii arm alone**:
   ```bash
   python3 corpus/scripts/regen_run.py --targets samples/ja-human \
     --arms torii --model gpt-5.6-luna --byok openrouter
   ```
6. Repack the 20 missing `project.zip` from the intact `project/` trees — a zip command, not a run.
7. Torii model comparison — 30 pages (10 per language) × 2 extra translators from the verified table.

### Phase 3 — still on the box
8. Capture Torii credit balance before/after from `torii_call.json`.
9. Verify artifact completeness per sample; **do not silently re-run a paid call** — use
   `fetch_torii.py --rederive` first.

### Phase 4 — tear down, then everything else locally
10. `build_translation_corpus.py`, the free-model benchmark, and the report — none of these touch
   the stack. Run them after teardown.
11. All of checklist §2 (erasure/masking — mask overlap bug, `sweep.py`, `crop2.py`, recall
    recovery, sample93/128/136) is local corpus analysis and is unaffected by the box. It is the
    natural thing for me to work on **while the batch runs**.

### Recording rules for this run
- Take the TL/QA model from `tl.cost.breakdown[].model`, **never** `metadataJson.model` (finding B).
- Exclude SFX regions from the scoring set (finding E).
- Record BYOK vs credits mode per sample; do not mix the two in one comparison.
- Rank everything by **cost per page against Torii's $0.0024**.

---

## 7. Lower-priority notes

- **Stack data is on the root disk**, `/home/sagnik/Documents/docker-composes/manga-tl/data`, not
  `/mnt/hdd` as the deploy plan specified. Root is 92 % full with **38 G free** (better than the
  10 G the plan feared), and the run needs a few GB, so this is survivable — but `data/old` is
  2.4 G of leftovers if you want easy headroom.
- **Account role is `admin`**, not the TRANSLATOR you picked in checklist §0. On a disposable box
  that is fine and it makes scratch-series cleanup work fully.
- **`--keep-pages` is not worth it here.** Your "leave the images" answer assumed a persistent
  stack; on a box being torn down it preserves nothing, and it breaks the `pageNumber: 1` invariant
  that shared scratch chapters rely on. The artifacts we keep are downloaded locally either way.
- **`.gitignore` has an uncommitted `backend/*`** — the Java tree is ignored rather than deleted.
  The plan's step was `git rm -r backend/`. Worth reconciling before the next commit.
