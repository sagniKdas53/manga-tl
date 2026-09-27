# Handoff — R7 (editor shows the cleaned page), after the build session of 2026-09-27

Repo: `/home/sagnik/Projects/docker-composes/manga-library`, branch `feat/output-quality`, parent HEAD `1f1b22b`, worker submodule HEAD `c6f0760`. **Everything R7 is uncommitted** in both the parent and `worker/`. The user said: commit only when they ask.

## Read these first (don't re-derive them)

- `docs/quality-checkpoints/R7.md` — the result: what changed, the gate tables, what was not executed, state left on the dev stack.
- `docs/quality-checkpoints/R7-inpainting-layer-handoff-20260927.md` — the original brief (§3 build order, §4 gate, §5 rules, §6 hand-back).
- `docs/output-quality-implementation-tracker.md` — top section "Status at a glance (2026-09-27 — R7 built; waiting for the user's review)" and the R7 row.
- Memory, already indexed: `r7-decisions.md` (D1–D4 and the spend cap), `rerender-queues-paid-qa.md`.
- `git status` / `git diff` in the parent and in `worker/` show the full change set.

## Where things stand

- R7 is built, deployed to the dev stack `manga-quality-dev` (UI `http://192.168.0.130:18080/tlhub/`), and gate-checked. Every check passed; the results are in R7.md.
- The images were rebuilt from the final tree. All gates were re-run on it and passed:
  - backend: fmt, clippy `-D warnings`, 235 tests;
  - worker: ruff, pyright, 621 tests;
  - frontend: typecheck, lint, 446 tests, build;
  - contract fixtures;
  - page-renderer: 4 tests.
- **Waiting on the user:**
  1. Their review of R7 in the editor. It isn't called done until then.
  2. The go-ahead to commit.
- The final report already proposed a commit split; the user hasn't answered.

## Next steps

1. **If the user reports problems from their review:** fix them, re-run the affected gate script, and update R7.md.
2. **When the user says commit:**
   - Worker first: commit and push `worker/` (4 files). Then bump the parent's submodule pointer.
   - Parent commits, in the handoff's step order:
     1. asset route;
     2. model and contract (contracts/, `page_scene.rs`, `ContentScene.ts` plus the tracked `services/page-renderer/dist/scene-static.js(.map)`, `init.sql`, the migration, `models.rs`, `inpainting.rs`, the worker pointer);
     3. drawing;
     4. editing (element routes, golden spec element fields, `schema.d.ts`, the patch handles, undo, `PatchInspector`, sidebar);
     5. round trip (import, export baking);
     6. builder and export follows the editor (plus the creation paths in `internal.rs` and `page.rs`);
     7. docs and harness (R7.md, tracker, `scripts/playwright/r7_*.cjs`, `scripts/quality/r7_*.py`, the `capture_quality_baseline.cjs` fix, `docs/quality-runs/r7-20260927-gate/pre-r7-export-digests.csv`).
   - `Reader.tsx`, `routes/page.rs`, `page_scene_builder.rs` and `golden-openapi.json` mix several steps. `git add -p` is unavailable, so build per-step patches and stage them with `git apply --cached`.
   - Each commit must build and pass on its own. If a split can't, merge adjacent steps and say so.
   - Run `detect_changes({scope:"staged"})` before each commit: `repo: "manga-library"` for the parent, `repo: "manga-tl-worker"` for the worker. Expect many "touched" symbols that are only line shifts.
   - **Keep out:** `AGENTS.md` and `CLAUDE.md` (GitNexus index-stat rewrites, not R7).
   - End commit messages with the attribution lines from the session's system reminder.
3. **After the review:** delete the throwaway account and its data. The account is `ui-check-r7-*@example.invalid`, role translator. Its data is the four series named "R7 round-trip …", and the "A03 retained baselines ja 2026-09-27T05:…" series only if the user agrees. The account's credentials lived in a session scratchpad file that is gone; delete via SQL or an admin account instead.
4. **Then:** the typesetting phase from the tracker: `AUDIT-R21` grouping, `AUDIT-R23` rotation, then M7. M7 includes the text-parity gaps recorded in R7.md: font weight, line breaks, text z-order after import.

## Things not written elsewhere

- **QA suppression on the fixtures.** The six fixture pages each have one patch saved unchanged (`is_manually_edited`), so re-renders don't queue paid QA. Keep it that way for any further gate runs. Details: memory `rerender-queues-paid-qa`.
- **Gate scripts.** They need `TLHUB_EMAIL` and `TLHUB_PASSWORD` in the environment. The first three are Node scripts under `scripts/playwright/`; the last two are Python under `scripts/quality/`, run with `.venv/bin/python`.
  - `r7_parity.cjs` — the text-hidden parity pass, with `--hide-text --mark-edited`.
  - `r7_behaviour.cjs` — the hide, delete, move, round-trip, fallback and download checks.
  - `r7_handles.cjs` — the real-mouse handle run.
  - `r7_compare.py` — the RGBA comparison of the parity captures.
  - `r7_recompose.py` — the independent composite check after a delete.
- **Dry-run tool.** `backend-rust/examples/r7_scene_diff.rs` runs against a DB copy. The scratch copy lives on the test Postgres at `127.0.0.1:55490`, database `r7_dryrun` (password in `backend-rust/scripts/test-deps.yml`). It disappears with `scripts/test-env.sh down`.
- **Budget.** The OpenRouter cap was $0.25; $0.167 is used. Don't start paid runs without asking.
- **Hard rules still apply:** never touch chrome-box production; no source images, credentials or raw dialogue in docs; the worker commit must be pushed before the parent pointer moves.

## Suggested skills

- `superpowers:verification-before-completion` — before claiming any fix or commit is done.
- `gitnexus-impact-analysis` — before editing any symbol: `impact()` first, and report HIGH or CRITICAL.
- `superpowers:finishing-a-development-branch` — when the user decides how to integrate after committing.
- `superpowers:systematic-debugging` — if the user's review surfaces a defect.
- `webapp-testing` — to reproduce anything the user sees in the editor with Playwright.
