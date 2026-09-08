# Plan — merge `rust-backend`, deploy the stack to `chrome-box`

**Date:** 2026-08-28 · **Status:** finalized, pending execution
**Decided by you this session:** merge = `rust-backend` (not the inpainting worker) · target = `chrome-box`, whole stack
**Follows on from:** `docs/CHECKLIST_2026-08-28.md`

---

## 0. The naming trap this plan exists to avoid

"The rust worker" is ambiguous in this repo, and the two things it can mean are in **opposite
states**.

| | `rust-backend` (this repo) | `rust-worker` (worker repo) |
|---|---|---|
| What | Java/Spring → Rust/Axum **backend** rewrite | Rust **LaMa inpainting** worker |
| Size | 46 commits, level with `main` | 1 scaffold commit, 10 behind `main` |
| Tests | 129 green (81 unit + 48 integration, 17 suites) | 5 unit tests; **never ran end to end** |
| Gate | 71/71 route parity, equality-enforced | 40-page validation gate **never run** |
| Builds elsewhere? | yes, multi-arch amd64 + arm64 | **no** — `path` deps to `~/research/mit-rust` |
| Also pushed as | — | **`failed-rust-worker-port-attemp`** (same SHA) |

**This plan merges `rust-backend` only.** The Rust inpainting worker stays parked as a separate
project — it still has the unresolved FFC broadcast bug (`HANDOFF-phase1-inpainter.md` §6:
"post-fix run not completed locally"), and `docs/worker_rust_migration_plan_2026-08-26.md` already
recommends not starting it until the Python plate builder has been profiled.

---

## 1. Sequencing — deploy *before* merge

`rust-backend`'s punch list has exactly one item that needs machinery rather than a decision: the
**real-worker >2 MB end-to-end pipeline run**. It has never been executed because it needs the ML
worker up.

The chrome-box deployment brings the ML worker up. So run it there and merge with the evidence in
hand, rather than merging on the assumption it passes.

```
Part B (deploy) ──► >2 MB E2E green on chrome-box ──► Part A (merge) ──► tag
```

Nothing in Part B depends on the merge having happened: chrome-box can check out the
`rust-backend` branch directly.

---

## 2. Part B — deploy to `chrome-box`

### 2.1 Pre-flight facts (verified 2026-08-28)

| Check | Result |
|---|---|
| Arch | `x86_64` — matches the worker image, which is **`linux/amd64` only** |
| Docker | 29.5.3 |
| CPU | Intel i7-5500U, 2 physical cores / 4 threads |
| RAM | 15 GB |
| Port 8080 | **free** (in use: 22 53 80 443 631 2283 3003 4000 6881 7002 8096 11434 …) |
| Root disk | 468 G, **98 % full, 10 G free** ⚠ |
| Second disk | `/mnt/hdd` — 4.6 T, **2.8 T free** ✅ |
| Already running | dashy, dozzle, jellyfin, immich (server + postgres + **machine-learning**), watchtower |

### 2.2 Only port 8080 needs to be published

Confirmed by reading the backend, not assumed:

- Browser-facing image URLs are **backend-relative** — `routes/page.rs:93` builds
  `{context_path}/api/images/{id}/file`. The bytes proxy through the backend.
- Presigned MinIO URLs appear **only** in `routes/internal.rs:375`, which the worker calls from
  inside the compose network, where `minio:9000` resolves.

**Therefore `MINIO_EXTERNAL_URL` stays empty and MinIO stays unpublished.** A remote deploy does not
break image loading. This was the biggest thing that could have gone wrong, and it does not apply.

### 2.3 Disk — fix before deploying

Root at 98 % is the main operational risk. The stack needs ~3.8 GB of images (the worker alone is
1.94 GB) plus data.

```bash
# Safe, frees ~11 GB on root immediately:
docker builder prune -f

# Put the stack's data on the big disk instead of root:
sudo mkdir -p /mnt/hdd/manga-library
```

> **Do NOT run `docker volume prune`.** `docker system df` reports 17.69 GB reclaimable across 4
> unused volumes, but chrome-box runs immich — some of that is plausibly immich test data. Freeing
> it is your call, made by inspection, not by a blanket prune.

### 2.4 Deployment steps

```bash
# 1. Check out onto the big disk, with the worker submodule
cd /mnt/hdd/manga-library
git clone ssh://git@pi5.tail9ece4.ts.net:2222/sagnik/manga-library.git .
git checkout rust-backend
git submodule update --init worker

# 2. Secrets — over ssh, never through git.
#    NOTE the glob: seven are .txt but api_keys is .json, so `secrets/*.txt`
#    would silently skip it and the worker would come up without provider keys.
#    db_password.txt, minio_password.txt, jwt_secret.txt, internal_api_token.txt,
#    worker_api_secret.txt, grafana_admin_password.txt, grafana_db_password.txt,
#    api_keys.json
scp secrets/* chrome-box:/mnt/hdd/manga-library/secrets/
scp .env      chrome-box:/mnt/hdd/manga-library/.env

# 3. Seed the model caches (~470 MB), or the worker dies at boot with
#    "Required YOLO bubble detection model is not available"
rsync -a data/worker/huggingface/ chrome-box:/mnt/hdd/manga-library/data/worker/huggingface/
rsync -a data/worker/paddlex/     chrome-box:/mnt/hdd/manga-library/data/worker/paddlex/

# 4. The prometheus/grafana bind-mount ownership trap (documented in commit 9c295a0).
#    Docker creates a missing bind source as root:root; prometheus then crash-loops with
#    "open /prometheus/queries.active: permission denied". No host sudo needed:
mkdir -p data/prometheus data/grafana
docker run --rm -v "$PWD/data:/d" alpine:3 \
  sh -c 'chown 1000:1000 /d/prometheus && chown 472:472 /d/grafana'

# 5. Bring it up — note: NO --profile watchtower (see 2.5)
docker compose up -d
```

### 2.5 Two config changes chrome-box specifically needs

**a) Neutralise the watchtower collision.** chrome-box already runs a watchtower with
`WATCHTOWER_LABEL_ENABLE=true` on a `@daily` schedule. Our compose puts
`com.centurylinklabs.watchtower.enable=true` on the **backend (L253) and worker (L401)**. Left
alone, chrome-box's watchtower will pull and restart both **once a day — including in the middle of
the 150-page batch**, killing in-flight jobs.

Fix with an override rather than editing the tracked compose file:

```yaml
# docker-compose.chrome-box.yml
services:
  backend:
    labels: ["com.centurylinklabs.watchtower.enable=false"]
  worker:
    labels: ["com.centurylinklabs.watchtower.enable=false"]
```

Our own watchtower service is already behind `profiles: ["watchtower"]`, so a plain
`docker compose up` never starts it. Just don't pass the profile.

**b) Leave `MAX_HEAVY_SLOTS=1`.** chrome-box has 2 *physical* cores. `regen_run.py`'s header is
explicit that the app arm is gated by the single serialized heavy OCR slot, and that raising
`--app-shards` requires raising `MAX_HEAVY_SLOTS` **and** the CPU cap first. Neither is worth doing
on a 2-core box. Both are already env-tunable for the day a bigger box exists.

### 2.6 Point the tooling at it — no code change required

`scripts/playwright/export_pending.cjs:66` already reads `TLHUB_BASE`:

```bash
export TLHUB_BASE=http://chrome-box:8080/tlhub   # tailnet DNS
export TLHUB_EMAIL=... TLHUB_PASSWORD=...
```

`regen_run.py`'s app arm shells out to `export_pending.cjs`, so it inherits this. The Torii arm
talks to `api.toriitranslate.com` and does not care where our stack lives.

### 2.7 Acceptance checks

1. `curl -f http://chrome-box:8080/tlhub/actuator/health`
2. Log in through the SPA at `http://chrome-box:8080/tlhub` (embedded in the binary via rust-embed)
3. `node backend-rust/scripts/e2e-smoke.js` — uploads the 2.58 MB seeded-noise PNG
4. **The gating one:** one real page through OCR → inpaint → LLM translation → QA with a >2 MB
   source image. This is `rust-backend`'s last open verification item.
5. Grafana panels fill while that pipeline runs (the other half of MIGRATION.md step 9)

---

## 3. Part A — merge `rust-backend` → main

Only after check 4 above is green.

```bash
# 1. The deletion a sandbox guard refused last session
git rm -r backend/
git rm .github/workflows/ci-maven.yml docker-compose.rust-test.yml
```

> `docker-compose.rust-test.yml` used to point the huggingface/paddlex mounts at the canonical
> checkout. That intent is preserved by the symlinks already in place — check they survive the
> delete before committing.

```bash
# 2. Full gate (Docker daemon required; confirmed available on this laptop)
cd backend-rust && ./scripts/test-env.sh run     # fmt + clippy -D warnings + 129 tests

# 3. Route parity — now an equality gate, fails in both directions
python3 scripts/diff_routes.py                   # expect 71/71

# 4. Merge PR #91, push BOTH remotes, tag.
#    The repo convention is github AND pi5, every time.
```

### Still unverified after this merge, and honestly so

- **The arm64 *runtime* stage.** The arm64 *builder* was fixed and verified this session (aarch64
  ELF confirmed for both binaries), but the final runtime stage needs QEMU binfmt, which is not
  registered on this host. It is 4 `COPY`s plus two `useradd`s on `debian:bookworm-slim` — low
  risk, but say "unverified", not "fine". CI's `setup-qemu-action` covers it. **Irrelevant for
  chrome-box (x86_64); it becomes blocking only if pi5 is ever revisited.**

---

## 4. What this does and does not buy you

**It does:** free the laptop completely. The worker's 2 CPUs and 4 GB stop competing with your
desktop on a 4-thread machine, and the 150-page run stops holding your laptop hostage.

**It does not:** make the run faster. Stated plainly, because the numbers say so —

| | laptop | chrome-box |
|---|---|---|
| CPU | i5-7200U (Kaby Lake) | i7-5500U (**Broadwell, older**) |
| Physical cores | 2 | 2 |
| Contention | your desktop | jellyfin + immich **machine-learning** + 3 more |

Expect throughput **the same or somewhat worse**. Consider pausing immich's ML container during a
batch if it turns out to matter — measure before assuming it does.

**The only thing that would genuinely speed up the run is more real cores** (≥8), because the app
arm is serialized on one heavy OCR slot. `MAX_HEAVY_SLOTS` and `WORKER_CPUS` are already env vars,
so that day is a config change, not a code change.

Also worth knowing: **pi5 has the best CPU of the three** (4 real Cortex-A76 cores) and 72 G free —
but the Python worker CI publishes `linux/amd64` only, so using it needs an arm64 PaddleOCR +
onnxruntime image built first. That is a real project with an uncertain outcome, not a deploy step.

---

## 5. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| chrome-box root disk at 98 % | **high** | `docker builder prune`; stack data on `/mnt/hdd` |
| chrome-box watchtower restarts worker mid-batch | **high** | override labels to `false` (§2.5a) |
| Model caches not seeded → worker won't boot | medium | rsync step 3; failure is loud and immediate |
| prometheus/grafana bind ownership | medium | pre-chown, step 4 — known, documented, one command |
| Contention with immich ML / jellyfin | medium | measure; pause immich ML during batches if needed |
| Secrets copied to a second host | medium | 8 files, scp only, never git; they now live in two places |
| arm64 runtime stage unverified | low | not on the chrome-box path at all |

---

## 6. Interaction with the rest of the checklist

- **Regenerating all samples** (your decision in `CHECKLIST_2026-08-28.md` §4) lands neatly here:
  a fresh chrome-box deployment starts with an empty MinIO and Postgres, so there is **no data
  migration to do**. The clean slate you asked for is a side effect of the move, not extra work.
- **The Gemini-delegated run** (§1) should not start until chrome-box is up and check 4 is green,
  or it will be pointed at a stack that is about to move.
- **The erasure/masking work** (§2) is all local analysis on the corpus and is unaffected by where
  the stack runs.
