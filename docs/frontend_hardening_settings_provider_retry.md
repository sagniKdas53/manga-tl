# Frontend hardening: settings modal vs a not-yet-published provider catalog

**Status:** proposal (post-migration backlog — deliberately out of Phase 4 scope, which
is parity-only). **Area:** `frontend/src/components/SettingsModal.tsx`. **Reported:**
2026-08-26 as "settings defaults are not getting selected automatically" on the Rust
test stack; triaged as environmental (empty Redis catalog), not a port bug — but the
modal's behavior made a transient state look like a bug, which is the actual defect.

## Observed behavior

With no provider catalog published yet (fresh stack, worker still booting, or worker
without API keys), every model/provider dropdown renders empty or `N/A (Capability
Missing)` and **never recovers**, even after the worker publishes seconds later. The
user must close and reopen the modal.

## Root cause chain

1. The worker publishes `system:providers:config` to Redis at FastAPI startup
   (`worker/src/worker/provider_config.py:327-339`), filtered to providers it holds API
   keys for. Until that moment the backend serves `activeProviders: []` and
   `providerModelsMap: {}`.
2. `SettingsModal.tsx` has two availability gates:
   - `isProviderUnavailable` (`:29-33`) = `!value || (activeProviders.length > 0 &&
     !included)` — with `activeProviders == []` any stored value is considered
     *available*, so no "unavailable" signal fires.
   - `isCapabilityMissing` (`:43-54`) correctly treats an empty map as missing, but only
     forces the per-select `N/A` rendering (`:69-78`); it does not drive refetching.
3. The background refetch loop (`:135-204`) retries **only while**
   `isAnyProviderUnavailable(data)` (`:173`, `:190`). Empty `activeProviders` makes that
   predicate `false`, so the loop exits immediately and the stale empty payload is kept.

Net effect: a boot-order race (UI opened before worker publish) degrades into a
permanent dead end requiring manual interaction.

## Proposed change

1. **Treat an absent catalog as "unavailable":** extend `isProviderUnavailable` (or add
   `isCatalogMissing`) so `activeProviders.length === 0` counts as unavailable, feeding
   `isAnyProviderUnavailable`. The existing refetch loop then keeps polling until the
   worker publishes, with zero new machinery.
2. **Bound the retry:** cap the loop (e.g., 30 attempts × 2s ≈ 1 min, then back off to
   15s indefinitely or stop). Prevents a genuinely keyless deployment from spinning
   forever; today's code stops instantly instead of forever, so this is strictly better.
3. **Say what is happening:** while the catalog is missing show a non-blocking alert in
   the modal ("Waiting for worker to publish provider configuration…") instead of silent
   `N/A`s. Distinguishes "not published yet" from "published empty because no API keys"
   — the latter already logs a warning worker-side (`config.py:549-550`).
4. **Optional (small backend addition, needs contract discussion):** include a
   `catalogPublishedAt` timestamp in `GET /api/settings` so the UI can tell "never
   published" from "published empty". Frontend-only alternative: probe the same Redis
   fact indirectly by retrying longer when `providerModelsMap` is `{}` but env model
   lists are non-empty. Defer unless (2)/(3) prove insufficient.

## Edge cases

- Keyless deployment: bounded retry ends in the alert state; message should point at
  worker logs (`docker logs manga-rust-worker | grep -i provider`).
- Worker restart mid-session: pub/sub already pushes updates server-side; the modal's
  periodic refetch picks the new catalog up within one interval once unblocked by (1).
- Legacy env-list fallbacks (`tlLlmModelList` etc., `:258`) must stay unused — the map
  is the sole source of truth by design.

## Test plan

- Vitest/RTL unit tests around the gate predicates: empty/non-empty `activeProviders`,
  map `{}` vs populated, retry budget exhaustion, recovery when the fetch starts
  returning a populated catalog.
- Manual E2E: start backend with redis flushed and worker paused → open settings →
  observe alert + retries → start worker → observe dropdowns populate without closing
  the modal.

**Effort:** ~half a day including tests. No backend/API change required for (1)-(3).
