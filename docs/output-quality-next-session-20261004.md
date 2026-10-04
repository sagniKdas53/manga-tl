# Output quality — handoff for 2026-10-04

## Start here

`main` is clean at the merge of this handoff (parent), worker `ac5a469`, corpus `8b858693`
(`v1-baseline`). All three checkouts are on `main` with nothing uncommitted. The
[tracker](output-quality-implementation-tracker.md)'s plan for 2026-10-03 is done except its
afternoon item, which is the first job below.

**Tomorrow, in order:**
1. ~~Write the C + G packet~~ **Done 2026-10-04** ([packet](output-quality-cg-packet-20261004.md)). Start
   with A.
2. Then the follow-ups in order of output value: **A** cleanup masks, **B** one balloon one text
   unit, **C + G** typesetting (from the packet), **F** Photoshop-style layers, **E** automatic
   angles.
3. After the tracker: the rest of corpus-v2, then **M9** (validate, regenerate the corpus, promote;
   this is the corpus rebuild), then a fresh prod stack. The user set this order on 2026-10-02.

## What 2026-10-03 did

| Item | Kind | Where | Result |
| --- | --- | --- | --- |
| I: `SELF_HOSTED_ADMIN` | upkeep | #167 | Every signed-in user is an admin when on; on by default in the compose files. |
| G1: fonts before the first fit | output | #168 | The editor fits again once the page's web fonts load (ch. 6 p. 1: 8 lines → 6). |
| G4: no fallback plate on import | output | #168 | An imported text polygon stays on its element; no patch is made. |
| H2: repaint fence | upkeep | #169 | A repaint is refused if a patch under it changed while it ran; checked under a page-row lock. |
| Item 6: throwaway accounts | upkeep | #170 | `database/ops/reassign-and-delete-user.sql`, tested. |
| G3: elliptical text | output | #171 | The export wraps elliptical text in the ellipse, as the editor does; the ZIP stops uppercasing it. |
| Corpus rescue | data | corpus #6 | The 2026-08-23 backup tar is unpacked in `gaps/_rescued/`; the tar is deleted. |
| Corpus-v2 Phase 0 | upkeep | corpus #7 | `v2/` baseline (12,181 files), tag `v1-baseline` on GitHub and pi5. |
| Disk | upkeep | — | The parent's `ocr-clone-cleanup` worktree (17 GB) removed; 108 GB free. |

Every PR went through CodeRabbit and had its findings fixed. The last was #171, merged with one
minor wording point open; it is fixed in this handoff's tracker edit.

**Dropped by the user:** the prod deploy and the prod SQL run. A fresh prod stack is built when the
tracker is done.

## 1. The C + G packet (write first, no code)

**Written 2026-10-04:** [output-quality-cg-packet-20261004.md](output-quality-cg-packet-20261004.md),
with three decisions for the user. The user also set A (cleanup masks) as an edge case: a small
fix, not a project. Build order stays A, B, C + G.

The goal is one packet that makes the editor and the export draw text the same way, then adds the
text-style work. Write it as a plan doc with test pages and gates, and say for each part whether it
makes output better or is upkeep.

- **C: split `background_color`** into an outline colour and a plate colour. Needs a migration, a
  hand edit of `backend-rust/spec/golden-openapi.json` (nothing generates it), and frontend types.
- **Torii's contrast halo.** Measure `strokeColor` and `lineWidth` against font size from the 270
  Torii bundles. This costs nothing, and the numbers decide the default.
- **G2: `maskPolygon` in the page-scene contract.** Today the editor's fitter gets it and the scene
  doesn't, so a masked element can wrap differently in the export. Touches
  `contracts/page-scene-v1.schema.json`, the validators (Ajv, Rust `page_scene.rs`, Python), and the
  worker's pinned schema hash.
- **H1: check `PUT /pages/{id}/scene` against the schema.** Do it with G2, because both edit the same
  contract. See the sizing below.
- **Test pages:** ch. 6 p. 1, the six fixtures, a masked element, and elliptical elements.
- **M7 scope:** one text renderer for editor and export.

### How big H1 is

Small: a few hours including review.
- The schema already exists (`contracts/page-scene-v1.schema.json`, draft-07, with the rule-8
  fields).
- The route has one handler (`routes/page.rs::put_page_scene`), and no app code calls it.
- The work is to add a JSON Schema crate, compile the schema once at startup (`include_str!`), and
  run it before the hand-written `validate_page_scene`.
- The fixtures in `contracts/fixtures/page-scene-v1/` (valid and invalid cases) are ready-made tests.
- Only risk: a scene the hand rules accept but the schema rejects. Run the valid fixtures and a
  real editor scene through it first.
- It changes no output (upkeep).

## 2. Follow-ups after the packet

Details are in [the R7 close doc](output-quality-r7-close-20261001.md#follow-ups-in-order-of-output-value).
- **A — cleanup masks (output).** Close and fill the automatic mask; grow it over outlines and glows
  while the ring colour stays consistent. Measure offline first (pages 1, 2, 14, the six fixtures),
  bump the generator id, then one labelled re-run.
- **B — one balloon, one text unit (output, `AUDIT-R21`).** Your research is saved in
  [ocr-grouping-research-20261003.md](ocr-grouping-research-20261003.md), with the measured
  owner-veto numbers and the A/B data location added. Start with its Step 0 (measure which cause is
  real) before changing defaults. Gate: R21's 42 regions on 5 pages, the six fixtures with no
  cross-balloon merge, and page 2's 良くないけど staying its own text.
- **F — Photoshop-style layers (output, editor).** Add layer, merge down or visible, groups, undo of
  a merge that survives a reload.
- **E — automatic angles (output, `AUDIT-R23`).** OCR has the text angle in its quads but writes
  `rotation: 0`.

## Things to know

- **G3's one-time cost, per page.** The check that stopped the 2026-09-30 re-render storm
  (`reuse_unchanged_render`) cannot reuse the old render of a page with elliptical text, because its
  scene changed. So each such page pays once, the next time it renders (Render now, Export, or the
  sweep after an edit): one render, plus a paid QA pass unless it was edited by hand. It is not
  library-wide. A settings save makes no page dirty (since 2026-09-30), and nothing else marks every
  page. A bulk re-render of the library would pay it for every elliptical page at once.
- **`SELF_HOSTED_ADMIN` is on by default** and sign-up is open. When the fresh prod stack is built,
  set it `false` if anyone outside can reach it.
- **Fresh prod stack notes.** The main compose file mounts no ONNX files. A prod worker reads
  `data/worker/huggingface/models/{yolo11n_bubble,ctd_seg_dyn,lama_aot}.onnx`, owned by UID 10001.
  Agent auto mode refuses prod commands, even reads, so you run those.
- **Laptop throwaway account (optional).** If you still want it gone, run the SQL locally. It owns
  nothing, so only the delete happens:
  ```bash
  U=$(docker compose exec -T db printenv POSTGRES_USER)
  docker compose exec -T db psql -U "$U" -d manga_library \
    -v throwaway='<TLHUB_EMAIL from secrets/local-tlhub.env>' -v owner='<your account email>' \
    -f - < database/ops/reassign-and-delete-user.sql
  ```
- **MEGA** can be resumed; the corpus is on `main`.
- **Worker worktrees left:** `worker/.claude/worktrees/docs-cleanup` and `rapidocr-poc`. Delete them
  if no longer wanted.
- **GitNexus index is stale.** Run `node .gitnexus/run.cjs analyze` from the repo root, and from
  `worker/`, before the first `impact()`.
- **Testing on the laptop.** Backend tests need a throwaway Postgres (55432), MinIO (9000) and
  Valkey (6379) with `database/init.sql` loaded; use `cargo test --no-fail-fast`. Don't run cargo and
  vitest at the same time. `ReaderInpainting > saves an edit … after 30 s idle` failed once in a full
  run and passed alone and in CI.
