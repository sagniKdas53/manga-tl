# API hardening backlog — 2026-09-05

Uncommitted on purpose: these are known, accepted, and deferred. Not in PR #137, which stays the
page-numbering fix plus the one finding worth closing with it.

Came out of reviewing `backend-rust/src/routes/` after the page-move bug, which was not really about
page numbers: an endpoint trusted a value it had not checked and answered `200 OK` while doing
something wrong. Every line cited below was read, not inferred from naming.

**Already fixed in PR #137** — the wrapping `as i32` casts on client JSON (`page.rs` zOrder,
maxWidth, maxHeight; `layers.rs` `z_order_of`). `4294967296` arrived as `0`. Now saturating.

---

## F2 — A signing failure is reported as a successful login

**Where:** `routes/auth.rs:298` (register), `:326` (login), `:346` (refresh).

```rust
let token = state.jwt.generate_token(&user.email).unwrap_or_default();
```

`generate_token` returns `Result` (`jwt.rs:63`). On `Err`, `unwrap_or_default()` yields `""`, and all
three endpoints answer **`200 OK` with `token: ""`**.

**Not an auth bypass.** An empty token fails `decode` (`jwt.rs:79`), so nothing is let through. The
cost is diagnostic: the client stores an empty token, every later request 401s, and the user sees a
session that silently does not work rather than an error naming the cause.

**Likelihood is low** — with HMAC and a valid secret, `encode` effectively cannot fail. This matters
when the signing config is *wrong* (bad key, mismatched algorithm), which is exactly when a legible
error is worth most.

**Fix:** `Err` → 500 at all three sites. Roughly three lines. No contract change: nothing documents
an empty-token success.

---

## F5 — `unwrap_or_default()` turns database errors into empty results

**Where:** 53 sites across `routes/`.

A failed query becomes an empty `Vec` or `None`, and the handler serves it as a normal `200`. A
broken chapter listing is indistinguishable from an empty one — for the caller *and* in the logs.

The codebase already knows this is wrong. The AUDIT-T4 comment at `routes/page.rs:108` names this
exact shape:

> `totalElements`. That is worse than an error, because it looks like an answer.

The pattern survived that audit anyway, which is the point: it is the path of least resistance, so
it will keep reappearing unless the convention changes rather than individual sites.

**Why "low, but systemic":** each instance is minor and none is a security issue. Collectively they
mean the service has no reliable way to report that a read failed, so a partial database outage
presents as data loss rather than an error.

**Fix — not a mass rewrite.** Two things worth doing when someone next touches these files:

1. Target the **list endpoints** first, where empty and failed are indistinguishable to the caller.
   The single-row `find_*` helpers already map cleanly onto 404 and can stay.
2. Decide the convention deliberately alongside the `.expect()` question (below), since they are the
   same decision seen from two sides: `.expect()` makes a DB error loud and fatal,
   `unwrap_or_default()` makes it silent and invisible. Neither is "return an honest 500."

---

## Reviewed and deliberately not acted on

Recorded so they do not get re-raised as new findings.

- **Throttling on `/login` and `/register`** — no rate limiter or lockout exists anywhere (grepped
  `governor`, `RateLimit`, `tower::limit`, `attempt`, `lockout`). Correctly a **middleware**
  concern, not a per-endpoint one, so it belongs with the reverse-proxy/middleware layer rather than
  in these handlers.
- **`viewer` role enforcement** — guarded per-handler: `page.rs` 5, `layers.rs` 1, `series.rs` **0**.
  `routes/series.rs:11` documents "any authenticated role" as deliberate Java parity. Also a
  middleware-shaped concern: if `viewer` is to be read-only everywhere, that is one method+path rule,
  not 38 handler-level checks.
- **Login timing discloses which emails are registered** (`routes/auth.rs:319-324`) — an unknown
  email returns 401 without running bcrypt; a known one pays the full verify, and bcrypt is
  deliberately slow, so the gap is measurable. Assessed as not worth acting on.

  One correction for the record, since it may come up again: password **hashing and salting do not
  prevent this**. They protect stored credentials if the database leaks; the signal here is the
  *absence* of a hash computation on the miss path, so a stronger hash makes the timing gap wider,
  not narrower. The fix, if ever wanted, is to verify against a fixed dummy hash when the lookup
  misses so both paths cost the same. Filed as accepted risk, not as a resolved issue.

- **`.expect()` as the DB error strategy** — 55 sites in `routes/`, 25 in `page.rs`. Safe behind
  `CatchPanicLayer` (`routes/mod.rs:103`), and the established convention; PR #137 follows it rather
  than half-migrating one file. Worth one deliberate pass, paired with F5.

---

## Verified good — do not re-audit

| Area | Where | Why it holds |
|---|---|---|
| Request size | `routes/mod.rs:109`, `reject_oversized_body` | `Content-Length` checked before any extractor, so oversized bodies get one clean 413 instead of being mis-reported as malformed JSON. |
| Pagination | `routes/page.rs:96-123`, `routes/series.rs:402-440` | `size` clamped to 100; offset is `saturating_mul`; `sortBy` whitelisted; `sortDir` case-insensitive. (AUDIT-T4.) |
| Worker auth | `auth.rs:173-182` | **Fails closed** — an unset or empty `internal_api_token` makes every `/api/internal/**` call `Invalid` rather than disabling the check. Constant-time compare. |
| Upload page number | `routes/page.rs:347-349` | Clamped to `1..=max+1`, so a hostile `pageNumber` cannot open a hole. |
| Numeric coercion | `routes/layers.rs:32` (`deserialize_rounded_i32`), `:242` (`saturating_i32`) | NaN → 0, clamp, then cast. The pattern the F1 fix adopted. |
