# Performance Run Playbook

How to record a pipeline run with enough fidelity that the next session can do a real
performance analysis instead of guessing. Written 2026-08-01 alongside the audit in
[issues.md](./issues.md#audit-findings).

The output of a run is a single directory, `logs/runs/<timestamp>/`, holding backend and worker
logs, a 2-second queue-depth timeline, resource samples, per-job timings straight from the `jobs`
table, and your Firefox profile. `logs/` is gitignored, so nothing large is ever committed.

---

## 1. Before you start

+ **Stack healthy** — `docker compose ps` should show `backend`, `worker`, `db`, `redis`, `minio`
  and `db-backup` all `healthy`.
+ **Queues empty** — `docker exec manga-valkey valkey-cli keys 'queue:*'` should print nothing.
  A leftover queue makes the timeline unreadable.
+ **Take a backup** if you're about to do anything destructive:

  ```bash
  docker exec manga-db pg_dump -U tladmin -d manga_library --clean --if-exists \
    | gzip > data/manual-backups/manga_library-$(date +%Y%m%d-%H%M%S).sql.gz
  ```

+ **Decide the shape of the run and write it down** — number of pages, which chapter, which
  providers. Put it in the run's `NOTES.md` (step 5). Without it the numbers can't be compared
  against the next run.

> **Don't change any settings to "make it faster" first.** The point of this run is to measure the
> system as the audit found it. Tuning comes after, one variable at a time, with a run each.

---

## 2. Start the recorder

```bash
./scripts/capture-run.sh start
```

It prints the run directory and returns immediately. While it runs:

| file | cadence | what it's for |
| --- | --- | --- |
| `backend.log` / `worker.log` | live | dispatch decisions, per-stage timings, cooldowns |
| `queues.csv` | 2s | depth of all 9 queues + worker slot occupancy |
| `resources.csv` | 10s | CPU/mem for backend, worker, db, redis |
| `environment.md` | once | git SHA, container images, slot/rate-limit env, providers.json tasks |

`./scripts/capture-run.sh status` shows the latest sample if you want to check it's alive.

The sampler costs ~130 ms of host CPU every 2 s (one batched Redis `EVAL` plus one
`/capabilities` call). On a 4-core box that is under 1% — small enough not to move the numbers,
but worth knowing it isn't zero.

---

## 3. The Firefox profile

**Profile individual interactions, not the whole pipeline run.** A 15-minute capture at 1 ms
sampling produces a multi-GB blob that the analysis UI can barely open, and the interesting frames
drown in idle. Take several short, labelled profiles instead.

### Setup (once)

1. Open <https://profiler.firefox.com> and click **Enable Firefox Profiler Menu Button**.
2. Click the toolbar icon → **Settings**:
   + Preset: **Web Developer**
   + Sampling interval: **1 ms**
   + Buffer: **512 MB**
   + Features: tick **Screenshots** (lets you line frames up against what was on screen) and
     **JavaScript**. Leave the Gecko/platform threads off — this is a React problem, not a
     browser-internals problem.
3. Shortcuts: `Ctrl+Shift+1` start/stop, `Ctrl+Shift+2` capture.

### What to capture

Four short profiles, roughly 10–20 s each, aimed at the symptoms in `issues.md`:

| # | file name | what to do while recording |
| --- | --- | --- |
| 1 | `profile-chapter-switch.json.gz` | Open a chapter in the reader, then switch to another 3–4 times. Targets the "old chapter content stays visible for a split second" bug. |
| 2 | `profile-reader-interaction.json.gz` | With a page open, pan/zoom, toggle layers, open and edit a region in the right sidebar. Targets `AUDIT-F2` — 65 inline `sx` objects in a 1588-line `ReaderRightSidebar`. |
| 3 | `profile-queue-manager.json.gz` | With the pipeline **busy** (many jobs in flight), open the Queue Manager and leave it open ~15 s, then the Notification Centre. Targets "when there are too many jobs the queue and notification managers have noticeable lag". |
| 4 | `profile-theme-toggle.json.gz` | Toggle light/dark 3–4 times from a reader page. Targets `AUDIT-F1` — the whole MUI theme is rebuilt per toggle. |

### Saving

In the profiler tab, use the **download / save-to-file** button — **not "Upload"**. Uploading
publishes the profile to Mozilla's servers on a public URL, and these profiles contain your page
titles, series names and URLs.

Save all four into the run directory:

```text
logs/runs/<timestamp>/profile-*.json.gz
```

### Optional but useful

React DevTools → **Profiler** tab → record the same chapter switch, then "Export profile". Save as
`react-profile-chapter-switch.json`. It attributes time to components by name, which the Firefox
profile cannot do as directly.

---

## 4. Do the run

Kick off the e2e run in the UI — upload the pages, let the full OCR → layout → translation →
render → QA pipeline drain. Take the Firefox profiles at the moments described above (profile #3
specifically needs the queue to be busy, so take it mid-run).

Let the pipeline go fully idle before stopping, so the last stage's timings land in the DB.

---

## 5. Stop and annotate

```bash
./scripts/capture-run.sh stop
```

This kills the samplers, gzips the logs, and derives:

| file | contents |
| --- | --- |
| `jobs.csv` | every job in the window: type, status, attempt, page_id, trace_id, duration |
| `stage_summary.csv` | per stage: n, ok, failed, p50 / p95 / max / total seconds |
| `duplicate_jobs.csv` | `(page, type)` pairs that ran more than once — direct evidence for `AUDIT-P4` |
| `terminal_states.csv` | status histogram; any lingering `PENDING`/`PROCESSING` is `AUDIT-P2`/`P6` |
| `costs.csv` | per provider/model: calls, tokens, estimated cost |
| `log_signals.md` | counted occurrences of dispatch stalls, 429s, cooldowns, rate-limit sleeps |
| `db_counts_before/after.csv` | row deltas — a region count far above pages × regions means duplicate writes |

Then write `logs/runs/<timestamp>/NOTES.md` by hand. Two minutes here is worth more than any of
the automated output:

```markdown
# Run notes
- Pages uploaded: 20, chapter "X" of series "Y"
- Providers: OCR=<...>, TL=<...>, QA=<...>, QA_MODE=<...>
- Felt slow at: <when, doing what>
- Anything that looked wrong in the UI: <...>
- Profiles taken: 1,2,3,4  (or which ones you skipped and why)
```

---

## 6. Hand off to the next session

Start the next chat with the prompt below, filling in the run directory name. Everything after it
is already on disk, so the next session can work from data rather than re-deriving the codebase.

<!-- markdownlint-disable MD031 MD040 -->

```
Performance analysis of a recorded pipeline run.

CONTEXT
- Repo: manga-library (Spring Boot backend + Python FastAPI worker + React/MUI frontend).
- A full-stack audit was done on 2026-08-01. Its ~50 findings are in
  docs/issues.md under "Full-Stack Audit — 2026-08-01", each tagged AUDIT-<area><n>
  with file:line anchors. Read that section first — do not re-audit the codebase.
- I have since recorded a real e2e run. All data is in:

      logs/runs/<TIMESTAMP>/

DATA IN THAT DIRECTORY
  NOTES.md                what I did, by hand — read this first
  environment.md          git SHA, images, slot/rate-limit config, providers.json tasks
  jobs.csv                per-job: type,status,attempt,page_id,trace_id,duration_s,error
  stage_summary.csv       per-stage n / ok / failed / p50 / p95 / max / total seconds
  duplicate_jobs.csv      (page,type) pairs that ran more than once
  terminal_states.csv     job status histogram
  costs.csv               per provider/model tokens + estimated cost
  queues.csv              2s timeline: depth of all 9 queues + worker slot occupancy
  resources.csv           10s CPU/mem for backend, worker, db, redis
  backend.log.gz          dispatch decisions, DEBUG_TL noise, SSE, scheduler
  worker.log.gz           per-stage timings, rate-limit sleeps, cooldowns, provider calls
  log_signals.md          pre-counted occurrences of the interesting log patterns
  profile-*.json.gz       Firefox profiles (chapter switch, reader interaction,
                          queue manager under load, theme toggle)
  db_counts_before/after.csv

WHAT I WANT

1. Build the actual time budget for one page, end to end, from jobs.csv and
   stage_summary.csv. Where does wall-clock time really go — per stage, and how much
   is *not* in any stage (i.e. gaps between a job completing and the next being
   dispatched)? Cross-reference queues.csv: when a queue was non-empty and the worker
   had a free slot, that gap is dispatcher latency, not work.

2. Test these audit hypotheses against the data and tell me which survive. Falsify
   them if the data says so — I would rather delete a wrong finding than fix it:
     - AUDIT-W2  the global RATE_LIMIT (default 10 RPM, one bucket for every
                 provider and task) is the dominant throughput ceiling.
                 log_signals.md has total sleep seconds; compare against wall clock.
     - AUDIT-P3  head-of-line blocking — dispatchFromSlot returns instead of
                 continuing, so one stuck job stalls every later queue in that slot
                 class. Look for queue:ocr sitting non-empty while an earlier heavy
                 queue was also non-empty.
     - AUDIT-P4  requeue-while-running produces duplicate work. duplicate_jobs.csv
                 plus the row deltas in db_counts_*.csv.
     - AUDIT-P2/P6  jobs stranded in PENDING or PROCESSING. terminal_states.csv.
     - AUDIT-W5  REUSE_IDLE_SLOTS never fires because the dispatcher gates on
                 maxLight. queues.csv: was active_light ever > max_light_slots?
     - AUDIT-W7  every job pays for a full getImageInfo call before doing any work.
     - AUDIT-B1  the single scheduler thread — look for the 5-minute stale sweeper
                 being late or skipped while dispatch was busy.

3. Analyse the Firefox profiles. For each, give me the top self-time frames and say
   whether the audit's frontend hypotheses hold:
     - AUDIT-F1  theme rebuilt from scratch on every light/dark toggle
     - AUDIT-F2  inline sx object literals causing Emotion cache misses
                 (ReaderRightSidebar: 65 of them, 1588 lines, zero memoisation)
     - the "previous chapter content stays visible for a split second" bug
   If a profile shows something the audit missed, say so plainly.

4. Rank the fixes by measured payoff, not by severity. I want "this costs N seconds
   per page, the fix is M lines" — not a priority label. Where the data cannot
   distinguish two causes, say what additional measurement would.

5. Then implement the top items, one at a time, each verifiable by re-running
   ./scripts/capture-run.sh and comparing stage_summary.csv against this baseline.

CONSTRAINTS
- Read docs/issues.md and logs/runs/<TIMESTAMP>/NOTES.md before proposing anything.
- Do not change more than one performance variable per change — I need to attribute
  the delta.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in here.
```

<!-- markdownlint-enable MD031 MD040 -->

---

## Re-running for comparison

After a fix, repeat sections 2–5. The comparison that matters is `stage_summary.csv` against the
baseline run, plus wall clock from `elapsed_seconds`. Keep every run directory — they're the only
record of what the system used to do.
