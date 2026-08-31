# Plan: structured OCR provenance, and populating `job_costs.stage`

**Status:** partially done, 2026-08-31, on worker branch `fix/cost-stage-and-ocr-model-label`
(committed, not pushed). The `job_costs.stage` half is complete, and the chunk-model bug below is
fixed. The `ocrProvenance` object itself is still not started — it was judged diagnostics rather
than output quality, and deferred deliberately. Split out of the cost-accounting work (worker
PR #30, parent PR #110) so it can be shaped alongside the versioned export schema rather than
bolted onto the cost fixes.

**Corrections found when the plan was picked up.** Two claims below were wrong and are marked
inline: the chunk problem is not a concurrency race, and the verification section named an env var
that does not exist.

**Two pieces, deliberately batched.** The OCR provenance object is the larger one; populating
`job_costs.stage` is a handful of lines. They are here together because the provenance design
*depends* on stage being populated (see "Populating `job_costs.stage`" below) and because the real
cost of either is the release — a worker commit, a submodule bump and a redeploy — not the code.

## Why

Everything worth recording about an OCR run is already in memory at the end of `process_ocr`, and it
is thrown away into a single display string:

```python
# worker/src/worker/handlers/ocr.py:1441
model_identifier = f"PaddleOCR({rec_model})"
if vlm_model_used:
    model_identifier += f" + {vlm_model_used}"
...
"modelIdentifier": model_identifier,   # :1450
```

That string is the *only* record of how a page was read. It cannot answer which detector ran, which
recogniser was selected for the page's language, whether the model that ran was the one configured,
or which of several chunks used which model. Three concrete problems follow from it:

1. **Detection provenance is lost entirely.** Detection always runs locally, even in cloud-VLM mode
   — only *recognition* is remote. `ocr.py:627` sets `use_paddle_ocr` from the provider, and
   `ocr.py:654` then builds `paddle_ocr_detector` precisely when `use_paddle_ocr` is false. So a
   "cloud OCR" page still went through local PP-OCR detection and the local YOLO bubble detector,
   and nothing anywhere says which versions.

2. **~~Concurrent chunks record whichever finished last.~~ FIXED 2026-08-31.** `vlm_model_used`
   was a single variable (`ocr.py:565`) assigned through `nonlocal` from inside the per-chunk worker
   (`ocr.py:1038`), at three fallback tiers (`:1076` user model, `:1112` global model, `:1163` local
   model), so a page whose chunks used two models reported only one.

   **This was not a race, as originally written.** The pool at `ocr.py:1178` runs `max_workers=1`,
   so chunks are sequential and the last one deterministically wins — mundane, not a concurrency
   bug. Now replaced by a list appended per chunk, with the label naming every distinct model in
   first-use order; single-model pages keep a byte-identical string.

3. **Silent model substitution is invisible.** Those three tiers are a fallback ladder: when the
   configured model fails, the next one is tried and only a warning is logged. Downstream there is
   no way to tell that a page was read by a different model than the one configured — which is
   exactly the question you ask when one page's output is inexplicably worse than its neighbours.

## What to record

A single `ocrProvenance` object on the OCR callback, alongside — never replacing — today's
`modelIdentifier`.

**Local recognition (`mode: "local"`)**

```jsonc
{
  "mode": "local",
  "detector": "PP-OCRv5_mobile_det",
  "recognizer": "en_PP-OCRv5_mobile_rec",   // per-language; the bug class ocr_models.py exists to prevent
  "catalogModelId": "PP-OCRv5",
  "requestedModelId": "PP-OCRv6",
  "autoRouted": true,                        // "you asked for v6; this language forced v5"
  "sourceLanguage": "ko",
  "bubbleDetector": { "path": "...", "sha256": "..." },
  "envOverride": { "det": "...", "rec": "..." }
}
```

**Cloud recognition (`mode: "cloud-vlm"`)** — the same local detection block, because it still ran,
plus the remote half and one entry per chunk:

```jsonc
{
  "mode": "cloud-vlm",
  "detector": "PP-OCRv5_mobile_det",
  "bubbleDetector": { "path": "...", "sha256": "..." },
  "recognizer": null,
  "vlm": {
    "provider": "openrouter",
    "modelRequested": "qwen/qwen3-vl-32b-instruct",
    "modelUsed": "qwen/qwen3-vl-32b-instruct",
    "usedFallbackModel": false,
    "routingStrategy": "lowest-cost",
    "batchSize": 10
  },
  "calls": [ /* one per chunk: generation id, model actually used, tokens, cost, duration */ ]
}
```

The per-chunk `calls[]` array is what fixes problem 2 — it removes the shared variable rather than
guarding it, so there is nothing left to race.

## Populating `job_costs.stage` — DONE 2026-08-31

The column existed and was always NULL. It was added with the rest of the provenance columns in
PR #110 and wired up in exactly one place — `worker/src/worker/services/ocr.py:125`, the cloud-OCR
path — so every call through the normal client records a blank. `record_llm_call` defaults it to
`""` and `llm_client._parse_response` never passes one.

**What it buys.** Which step of the pipeline spent the money: `ocr`, `translation`, `qa`,
`qa-re-ocr`, `region-redo-ocr`, `region-redo-tl`. Today that cannot be recovered from the row —
model name is not a proxy, because the same model serves several stages (all seven of the first
real provenance rows were `google/gemini-3.7-flash`, across different steps). Without it, "is OCR
or translation costing more per page" has no answer, and the Grafana per-model table cannot be
grouped by stage.

**Why it belongs with the OCR work.** The `calls[]` array below is specified as a filter over the
job's existing cost records — `stage == "ocr"` — rather than a parallel structure that can drift.
That filter matches nothing until stage is populated, so building the provenance object first would
mean writing a filter against a permanently blank field.

**How (as implemented).** Not by threading a parameter through `LLMClient` and the shared helpers in
`services/translation.py` — those are called by QA and redo as well as translation, so every caller
would have to supply it. Bind it as a `ContextVar` instead, in the one place every job already
passes through:

- `rq_tasks.process_job_rq(queue_name, job_data)` already receives the queue name and already binds
  both the trace id and (since PR #30) the job-scoped cost list. Bind the stage there too.
- The queue name *is* the stage: `queue_name.removeprefix("queue:")` yields `ocr`, `translation`,
  `qa`, `qa-re-ocr`, `region-redo-ocr`, `region-redo-tl` directly. No mapping table, and the two
  redo queues distinguish their own types without anyone reading `redoType`.
- `record_llm_call` reads the ContextVar when its `stage` argument is empty, so an explicit stage
  still wins and nothing needs a signature change.
- **Correction to the original plan:** it said the hardcoded `stage="ocr"` in `services/ocr.py:125`
  "keeps working". It kept working *wrongly*. That call site is `_record_cloud_ocr_cost`, reached
  only from `perform_redo_ocr`, whose only importers are `handlers/qa_re_ocr.py` and
  `handlers/redo.py` — so the one place a stage was ever set was the one place it was wrong,
  flattening every QA re-OCR and region redo to plain `ocr` and defeating exactly the distinction
  the ContextVar is chosen for. It was removed rather than kept.
- Chunk workers already inherit this: the executor call sites submit through
  `contextvars.copy_context().run`, added in PR #30 for the cost list.

Roughly five lines, mirroring the `trace_id` pattern in `worker/src/worker/config.py:35`.

**Caveat, now realised.** The 362 rows written before this landed keep a blank stage permanently —
nothing in the row records which handler produced it, so there is nothing to backfill from. Same
shape as the 204 pre-PR-#30 rows that can never be priced. If stage-level spend breakdowns matter
for the intervening data, this half is worth pulling forward on its own; it is independent of
everything else here except the `calls[]` filter.

## Redo cost accounting — DONE 2026-08-31, found while validating the above

Validating the stage work on chapter `d1e38221` turned up two holes that made the redo stages
impossible to observe: the spend never reached the database at all. Both predate this work — the
region-redo jobs from 2026-08-30 have no cost rows either — and both are now fixed.

1. **Worker, `handlers/redo.py`.** The cost payload was attached inside the `translation` branch
   only. `perform_redo_ocr` goes out to a paid cloud model whenever the OCR provider is not local,
   so a region redo billed for the call and dropped it — the same bug PR #30 fixed for redo
   translation and missed for redo OCR. The attach now happens once after both branches. The
   callback also carries `jobId` now, so the row can be tied back to the job that spent it.
2. **Backend, `handle_qa_re_ocr_callback`.** It never accepted a `cost` argument, and
   `save_job_costs` was only ever called from the OCR, translation and QA handlers. The worker has
   always sent one (`qa_re_ocr.py:113`); the backend took the callback and discarded the spend.
   `region_callback` had the same hole and had to resolve the image through the region's page
   before it could write the row.

Seven paid cloud-OCR calls went unrecorded before this was found (five on 2026-08-31, two on
2026-08-30). Those rows cannot be recovered.

**Testing note that cost an hour.** The backend integration suite silently no-ops when it cannot
reach Postgres: `app()` returns `None` and every test returns early, reporting green. It needs
`SPRING_DATASOURCE_USERNAME=tladmin`, not `postgres` — with the wrong user all seven tests in
`internal_endpoints.rs` "pass" in about a second without executing anything. Check the wall time
before believing a green run.

## Notes for whoever picks this up

- **The YOLO checksum already exists.** `worker/src/worker/services/bubble_detector.py:21` defines
  `get_sha256` and `:43` already computes it for the model file. Reuse it; do not add a second one.
- **`calls[]` entries should reuse the cost breakdown, not duplicate it.** After PR #30 each LLM
  call already produces a record carrying `generation_id`, `upstream_provider`, `model_resolved`,
  tokens, `cost_source` and `duration_ms`. Filter the job's cost list by `stage == "ocr"` rather
  than assembling a parallel structure that can drift. The stage work above has now landed, so this
  filter has something to match.
- **Keep `modelIdentifier` byte-identical for at least one release.** `corpus/scripts/
  corpus_audit.py:184` reads `metadataJson.model` off the OCR layer to answer "which engine read
  this page". Changing that string breaks the corpus audit silently. Add the structured object
  beside it and migrate that consumer separately.
- **This feeds the schema v1 envelope.** `ocrProvenance` is one of the things v1 exists to carry, and
  `corpus_audit.py:76` currently pins a worker commit sha by hand (`GEOMETRY_CUTOFF_SHA`) as a
  stand-in for a real version field. Landing provenance and the envelope together is what lets that
  hand-maintained constant be deleted.

## Verification

Run one page in each mode and confirm:

- local mode records detector, recogniser and the routing decision, and `autoRouted` is true when
  the language forces a different catalogue model than the one requested;
- cloud mode still records the local detector and bubble-detector checksum;
- a page split into N chunks produces N `calls[]` entries, each with its own generation id.
  **Correction:** the original plan said to set `OCR_BATCH_SIZE` low to force several chunks. No
  such env var exists anywhere in the worker — the chunk size is hardcoded to 10 at `ocr.py:1035`.
  Forcing multiple chunks means supplying more than ten regions, which is what
  `test_model_identifier_names_every_model_that_read_the_page` does with eleven;
- forcing the primary VLM to fail produces `usedFallbackModel: true` and a `modelUsed` that differs
  from `modelRequested`;
- `modelIdentifier` is unchanged, and `corpus_audit.py` still reports the same `ocr_model`.

For the stage half — **covered by unit tests, still wants one live page.** The properties below are
pinned in `tests/test_rq_tasks_extra.py` (queue-name derivation for all six stages, and unbinding
after a handler raises) and `tests/test_rate_limit.py` (chunk-thread inheritance, concurrent jobs not
bleeding, explicit stage winning). What no unit test covers is the round trip through the backend
into Postgres, so after the submodule bump and redeploy, run one page end to end and check the
column is populated for every step, not just OCR:

```sql
SELECT stage, count(*), round(sum(estimated_cost)::numeric, 5) AS spend
FROM job_costs
WHERE created_at > now() - interval '1 hour'
GROUP BY stage ORDER BY spend DESC NULLS LAST;
```

Expect one row per step the page went through and no NULL stage. Note that rows predating this
change stay NULL, so scope the query to recent rows or the old ones will look like a failure.

Once it is populated, the Grafana per-model table can group by stage, which is the point of the
exercise.
