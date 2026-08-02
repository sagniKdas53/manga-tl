# Frontend Performance Analysis — recorded runs of 2026-08-01

Deliverable #3 of the plan in [perf_run_playbook.md](./perf_run_playbook.md), against the profiles
in `logs/runs/`. Tests the frontend hypotheses from the audit in
[issues.md](./issues.md#full-stack-audit--2026-08-01).

Backend deliverables (#1, #2, #4) are **not** covered here — see
[Why the backend half is blocked](#why-the-backend-half-is-blocked).

---

## 1. Method

Firefox profiles are `preprocessedProfileVersion: 68`, where the stack/frame/func tables are shared
across threads and `stackTable` uses `prefixOffset` (`prefix = i - prefixOffset[i]`, `0` = root).

Three things matter for reading these correctly, and each one flips the conclusion if you get it
wrong:

1. **Use the right process.** Each profile has three `GeckoMain` threads. The app is
   `Isolated Web Content` (pid 1092533). The other high-CPU tab is Firefox's own DevTools UI —
   its Redux frames (`bindActionCreator`, `promiseMiddleware`) look like app code but are not.
2. **Weight by `threadCPUDelta`, not wall clock.** Sample `timeDeltas` include idle-coalesced
   gaps; by wall clock `__libc_poll` is 70–88% of every profile, which says nothing.
3. **Attribute self time to the nearest JS ancestor.** Leaf frames are almost always native
   (jemalloc, GC, display lists), so a naive leaf histogram reports **zero** JS.

Durations come from `meta.profilingStartTime/EndTime`. Summing `timeDeltas` gives 2–4 hours,
because those are offsets from browser-session start, not the capture window.

## 2. What each profile actually contains

All six align to their run windows. `LT` = LongTask marker.

| profile | run dir | window | content CPU | JS | LT | LT wall | LT CPU | max LT |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| theme toggle | `rapid-theme-change` | 45.1 s | 9.79 s | 4.32 s (44%) | 37 | 3.57 s | 2.41 s | 355 ms |
| chapter switch | `20260802-004944` | 55.0 s | 14.85 s | 5.95 s (40%) | 50 | 4.68 s | 2.56 s | 479 ms |
| reader sidebar | `20260801-230010` | 271.9 s | 16.21 s | 10.69 s (66%) | 76 | 11.04 s | 8.65 s | 690 ms |
| reader interaction | `20260801-225058` | 310.6 s | 18.38 s | 9.96 s (54%) | 113 | 14.07 s | 8.96 s | 554 ms |
| queue manager | `20260801-232928` | 528.0 s | 13.62 s | 5.08 s (37%) | 104 | 14.17 s | 4.77 s | 1846 ms |
| queue + notifications | `20260801-234852` | 376.3 s | 6.88 s | 2.36 s (34%) | 45 | 7.34 s | 2.36 s | 1055 ms |

The headline is the **LT wall vs LT CPU** columns. In the reader profiles the two track each
other — that jank is real computation. In the two queue profiles they diverge sharply, and that
turns out to be the most important result in this document.

---

## 3. Hypothesis results

### AUDIT-F1 — theme rebuilt from scratch on every toggle: **CONFIRMED, but small**

37 toggles in the capture produced exactly 37 LongTasks, totalling 3.57 s wall / 2.41 s CPU:

> **~96 ms of jank per theme toggle, ~65 ms of it CPU.**

Inside those tasks: React reconciliation `bh</Qe/<` 0.141 s, MUI `Wi` 0.101 s, and Emotion
`t.insert` 0.073 s. Across the whole profile, `vendor-mui` accounts for 1.60 s and `vendor-react`
1.39 s of the 9.79 s.

So the mechanism the audit describes is real and now has a number on it. But 96 ms on an action a
user takes a handful of times per session is the *lowest*-payoff item here, not a priority.

### AUDIT-F2 — inline `sx` causing Emotion cache misses: **MECHANISM FALSIFIED, LOCATION CONFIRMED**

Two parts of the finding do not survive:

- **"zero memoisation" is factually wrong.** `ReaderRightSidebar.tsx:1588` is
  `export default React.memo(ReaderRightSidebar);`.
- **Emotion insertion is not the cost.** `t.insert` never exceeds 0.073 s in *any* of the six
  profiles. If inline `sx` were thrashing the Emotion cache, this is where it would show, and it
  doesn't.

But the file the finding points at *is* the hot spot. In the sidebar profile, two closures in the
Reader bundle dominate:

| self CPU | frame | bundle |
| ---: | --- | --- |
| 1.324 s | `io/qn</t/xe<` | `Reader-Cc1iNrmR.js` |
| 1.113 s | `io/qn</t/F<` | `Reader-Cc1iNrmR.js` |
| 0.624 s | `ne` | `Reader-Cc1iNrmR.js` |

Together the first two are **2.44 s of the 8.65 s of CPU inside LongTasks (28%)**, and the Reader
bundle (4.155 s) outweighs MUI (2.163 s) and React (2.819 s).

**Verdict:** rewrite the finding. The sidebar is expensive because of its own logic, not because of
Emotion. I cannot name the two functions — the deployed bundles ship without sourcemaps (0 of 3235
sources carry content, and the Reader bundle has no `sourceMapURL`). Fixing that is a prerequisite
for acting on this item.

### The "old chapter content stays visible" bug: **FIXED, confirmed by the profile**

Matches `NOTES.md`. There is no long paint of stale content; the spinner path is taken instead.

What the profile *does* show, which the audit missed:

> **12 major GCs totalling 2.93 s in a 55 s window — 5.3% of wall clock, averaging 244 ms each.**

That is the single largest non-JS cost in the chapter-switch profile, larger than all its LongTask
CPU combined (2.56 s). Alongside it: 962 `load` events and 980 `anonymousrootcreated` /
964 `anonymousrootremoved` per capture — heavy DOM construction and teardown per switch. This is a
plausible mechanical explanation for "noticeable loading time for every chapter".

### Not in the audit: `queuePulse` keeps the Queue Manager permanently animating

`frontend/src/components/QueueManager.tsx:140`:

```jsx
animation: isCurrent ? "queuePulse 1.3s ease-in-out infinite" : "none",
"@keyframes queuePulse": {
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.3 },
},
```

This sits in the inline `sx` of **every stage bar of every job row** — `pipelineStages.map(...)`
inside a list that re-renders on every SSE update. The `@keyframes` block is redeclared per element
rather than defined once.

Evidence it is actually costing something:

- `animationiteration` is the **#1 DOM event** in both queue profiles — 3822 (queue manager) and
  1488 (queue + notifications) — and **0 in chapter-switch**.
- `CSS animation iteration` markers land at exactly **1300 ms**, matching the declared `1.3s`.
- Every rendering cost is multiples of the other profiles:

| marker | queue mgr | others |
| --- | ---: | ---: |
| `Styles` avg | **1.27 ms** | 0.33–0.45 ms |
| `ViewManagerFlush` avg | **20.27 ms** | 3.2–5.4 ms |
| `DisplayList` avg | **5.31 ms** | 0.73–1.05 ms |
| `RefreshDriverTick` total | **19.09 s** | 5.7–12.2 s |

Native self time in that profile corroborates it: `RetainedDisplayListBuilder::PreProcessDisplayList`,
`AnyContentAncestorModified`, `FlattenedDisplayListIterator` — retained-display-list invalidation
churn, i.e. the browser rebuilding display lists it hoped to reuse.

---

## 4. The caveat that changes the ranking

**Two thirds of the Queue Manager jank is not the frontend running slowly — it is the frontend not
running at all.**

Queue-manager LongTasks: **14.17 s wall, 4.77 s CPU**. The main thread was descheduled for ~9.4 s.
From the same run's `resources.csv`:

```
peak container CPU 278.84%  of 400% (4-core box)
sustained 172–202% through 18:02–18:06
```

The browser was competing with the pipeline it was displaying. So an unknown but substantial share
of the reported "lag when many jobs are running" is **host CPU starvation, not frontend code**.

`queuePulse` is still worth fixing — the marker evidence is independent of scheduling, and it makes
the frontend more expensive precisely when the box is busiest. But do not expect removing it to
recover the full 14 s.

**To separate the two:** profile the Queue Manager with a large job list rendered while the pipeline
is *idle*. If the elevated `Styles`/`DisplayList` averages persist, they are the animation; if they
collapse, they were starvation.

---

## 5. Ranked by measured payoff

| # | fix | measured cost today | size | confidence |
| --- | --- | --- | --- | --- |
| 1 | ~~Hoist `@keyframes queuePulse` to a single static definition~~ **done 2026-08-02** | 3–6× restyle/display-list cost | ~5 lines | High |
| 1b | Stop animating rows that aren't visible | 3822 animation events | medium | Medium |
| 2 | Cut per-chapter allocation churn | 2.93 s major GC per 55 s (5.3% of wall) | investigate first | Medium |
| 3 | Optimise the two hot Reader-bundle closures | 2.44 s of 8.65 s LongTask CPU (28%) | unknown | **Blocked on sourcemaps** |
| 4 | Memoise the MUI theme across toggles (AUDIT-F1) | 96 ms per toggle | small | High, low value |

Items 2 and 3 are deliberately not costed. For #3 the data cannot name the function; for #2 it shows
the GC but not the allocator.

---

## 6. Changes to the capture method

1. **Build with sourcemaps** for profiling runs. This is the single change that unblocks the largest
   measured item. Everything else is guesswork while frames read `io/qn</t/xe<`.
2. **Profile the frontend with the pipeline idle**, at least once, to separate CPU starvation from
   frontend cost on a 4-core box.
3. **Keep profiles to 10–20 s** as the playbook says. The 528 s queue capture dilutes its own
   interactions; the 45 s and 55 s captures were the most informative.
4. Keep exporting both the lean and full-thread variants — the lean ones are sufficient for all the
   above and load far faster.

---

## Why the backend half is blocked

Deliverables #1, #2 and #4 cannot be completed from these six runs:

- **No run drained to idle** (playbook §4). No image has a complete
  `panel-detection → ocr → layout → translation → render → qa` chain inside any window.
- **Three derived CSVs were empty in all six runs** — `terminal_states.csv`, `duplicate_jobs.csv`
  and `costs.csv` — from an `ORDER BY <position>` error against a single concatenated output column.
  `psql_q` discarded stderr, so the failures looked like empty results. Fixed in
  `scripts/capture-run.sh`; re-derived from the live DB, the runs did produce 116 LLM calls / $0.16
  and exactly one duplicate (`12d70335…`, `render`, ×2).
- **`jobs.csv` was windowed on `created_at` only**, hiding in-window work on earlier jobs. That is
  why `layout` read `n=9, ok=0, p50=0.00` while `backend.log` recorded 7 layout dispatches in the
  same window. Fixed.
- **Run `20260801-232928` is not a throughput baseline** — jobs and the global queue were paused by
  hand, and `duration_s` is `updated_at - created_at`, so it counts pause time as stage time.

One structural gap remains, and no re-run fixes it on its own:

> `jobs` has no dispatch timestamp, and the backend's `Dispatched job from queue:X` log line
> carries no job or trace id. So `duration_s` conflates **queue wait** with **work**, and the two
> cannot be separated — which is exactly what deliverable #1 asks for.

Re-derived over the full evening, `layout` has a p50 of **810 s** and a max of **2306 s** against an
OCR p50 of 20 s. Almost all of that is queue wait, but nothing in the current instrumentation proves
it.

**Fixed 2026-08-02** (`WorkerDispatcherService.java:215`): the dispatch line now logs the job id.

```
Dispatched job <jobId> from queue:ocr to worker ... (activeHeavy=…, activeLight=…, activeTotal=…)
```

The payload's `jobId` is the `jobs.id` primary key — `JobCoordinatorService` sets both from one UUID
— so `backend.log` joins directly to `jobs.csv`. From the next run onward:

- **queue wait** = dispatch timestamp − `created_at`
- **work** = `updated_at` − dispatch timestamp

which is what deliverable #1 needs. This is instrumentation only; it adds no work to the dispatch
path and cannot confound a throughput comparison.
