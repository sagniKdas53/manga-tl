#!/usr/bin/env python3
"""
bench_common.py — Shared plumbing for the benchmark runners (translation, OCR, QA).

Holds the pieces that were previously duplicated or missing:

  * The empirical structured-output ladder. For each (provider, model) we try, in order, until
    one succeeds:
        1. response_format: json_schema (strict)  -> "json_schema"
        2. response_format: json_object           -> "json_object"
        3. no response_format (prompt-only JSON)  -> "none"
    This measures actual structured-output support rather than trusting a provider's
    self-reported capability metadata (see docs/translation_bench.md §"Structured output:
    declared vs. actual"). benchmark_translation.py grew this first; benchmark_vlm_ocr.py had
    no ladder at all and hardcoded json_object, so a model supporting only json_schema or plain
    prompting scored as a hard failure.

  * Character error rate + CJK-aware text normalization, used to score OCR output against the
    corpus and to decide multi-engine consensus when building it.
"""

import re
import json
import time
import unicodedata
import concurrent.futures

import requests

_CALL_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="bench-call")


# ---------------------------------------------------------------------------
# Response cleanup
# ---------------------------------------------------------------------------

def strip_fences(content):
    """Strip a ```json ... ``` (or bare ```) wrapper some models emit around JSON."""
    content = content.strip()
    if content.startswith("```"):
        lines = content.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        content = "\n".join(lines).strip()
    return content


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def call_provider(url, headers, payload, timeout=90):
    """POST and time it. Returns (response|None, elapsed_seconds, network_error|None).

    `requests`' own `timeout=` is a socket-idle timeout, not a wall-clock deadline — a model
    that dribbles keep-alive bytes while "thinking" resets it on every chunk and can run far
    past the nominal cap (observed: a 60s timeout letting real calls run 130s+). Enforced here
    with a hard deadline via a worker thread instead: if `future.result(timeout=...)` doesn't
    return in time we give up waiting and record a timeout, even though the abandoned thread
    (and its socket) may still be running in the background — acceptable for a benchmark run
    where "didn't answer within the cap" should count as a fail regardless of what's still
    happening on the wire.
    """
    t0 = time.time()
    future = _CALL_EXECUTOR.submit(requests.post, url, headers=headers, json=payload, timeout=timeout)
    try:
        resp = future.result(timeout=timeout)
        return resp, time.time() - t0, None
    except concurrent.futures.TimeoutError:
        return None, time.time() - t0, f"hard_timeout: no response within {timeout}s"
    except Exception as e:  # noqa: BLE001 - any transport failure is just "network error"
        return None, time.time() - t0, str(e)


MODES = ("json_schema", "json_object", "none")


def apply_response_format(payload, mode, schema, schema_name="structured_output"):
    """Add the response_format for `mode` to `payload` (mutates and returns it)."""
    if mode == "json_schema":
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": schema_name, "schema": schema, "strict": True},
        }
    elif mode == "json_object":
        payload["response_format"] = {"type": "json_object"}
    else:
        payload.pop("response_format", None)
    return payload


def run_ladder(url, headers, build_payload, retries=1, timeout=60, backoff=5.0, modes=MODES):
    """Walk the structured-output ladder until one mode returns parseable JSON.

    `build_payload(mode)` must return a fresh request payload for that mode.

    Returns on success:
        {status: "ok", mode_used, elapsed_s, result, raw_content,
         prompt_tokens, completion_tokens, attempts_log}
    and on exhaustion:
        {status: "failed", mode_used: None, elapsed_s: None, attempts_log}

    Retry policy matches what benchmark_translation.py established: retry the same mode on a
    transient network error or a 429 (with linear backoff), but fall through to the next mode
    on any other HTTP error, empty content, or unparseable JSON — those indicate the mode is
    unsupported rather than a transient failure. A hard timeout (no response within `timeout`
    seconds — see call_provider) is deliberately excluded from the retry-same-mode path: a
    model that's too slow once is going to be too slow again, so retrying just doubles the wait
    for no benefit. It falls straight through to the next mode instead, same as an HTTP error.
    """
    attempts_log = []

    for mode in modes:
        payload = build_payload(mode)

        for attempt_num in range(retries + 1):
            resp, elapsed, net_err = call_provider(url, headers, payload, timeout=timeout)

            if resp is None:
                attempts_log.append({"mode": mode, "attempt": attempt_num,
                                     "error": f"network: {net_err}", "elapsed_s": elapsed})
                if net_err and net_err.startswith("hard_timeout"):
                    break  # too slow once = too slow again; don't burn another `timeout`s
                continue
            if resp.status_code == 429:
                attempts_log.append({"mode": mode, "attempt": attempt_num,
                                     "error": "rate_limited (429)", "elapsed_s": elapsed})
                time.sleep(backoff * (attempt_num + 1))
                continue
            if resp.status_code != 200:
                attempts_log.append({"mode": mode, "attempt": attempt_num,
                                     "error": f"http_{resp.status_code}: {resp.text[:500]}",
                                     "elapsed_s": elapsed})
                break  # next mode — likely an unsupported response_format

            data = resp.json()
            message = ((data.get("choices") or [{}])[0]).get("message", {}) or {}
            content = message.get("content", "") or ""
            usage = data.get("usage", {}) or {}

            if not content.strip():
                attempts_log.append({"mode": mode, "attempt": attempt_num,
                                     "error": "empty_content", "elapsed_s": elapsed})
                break

            cleaned = strip_fences(content)
            try:
                result = json.loads(cleaned)
            except json.JSONDecodeError as e:
                attempts_log.append({"mode": mode, "attempt": attempt_num,
                                     "error": f"json_decode_error: {e}", "elapsed_s": elapsed,
                                     "raw_content": content})
                break

            return {
                "status": "ok",
                "mode_used": mode,
                "elapsed_s": round(elapsed, 3),
                "result": result,
                "raw_content": content,
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "attempts_log": attempts_log,
            }

    return {"status": "failed", "mode_used": None, "elapsed_s": None, "attempts_log": attempts_log}


# ---------------------------------------------------------------------------
# Text scoring (OCR)
# ---------------------------------------------------------------------------

_WS = re.compile(r"\s+")


def normalize_text(text, drop_punctuation=True):
    """NFKC-fold, strip whitespace, and optionally drop punctuation.

    NFKC matters for CJK: engines disagree on full-width vs half-width forms (７ vs 7, ！ vs !)
    and on prolonged-sound-mark lookalikes, which are transcription-equivalent and should not
    count as character errors.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    if drop_punctuation:
        text = "".join(ch for ch in text if not unicodedata.category(ch).startswith("P"))
    return _WS.sub("", text).strip()


def levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(hypothesis, reference, normalize=True):
    """Character error rate of `hypothesis` against `reference`, capped at 1.0.

    Returns None when the reference is empty (nothing to score against) so callers can exclude
    the region rather than silently recording a perfect or catastrophic score.
    """
    if normalize:
        hypothesis, reference = normalize_text(hypothesis), normalize_text(reference)
    if not reference:
        return None
    return min(1.0, levenshtein(hypothesis, reference) / len(reference))


# ---------------------------------------------------------------------------
# Geometry (OCR detection scoring)
# ---------------------------------------------------------------------------

def iou(box_a, box_b):
    """Intersection-over-union of two [x, y, w, h] boxes."""
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b
    ix1, iy1 = max(ax, bx), max(ay, by)
    ix2, iy2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


# ---------------------------------------------------------------------------
# Summary reporting
# ---------------------------------------------------------------------------

def print_summary_table(summary, columns, title):
    """Print the aligned per-model table the benchmark runners end with.

    `columns` is a list of (header, key, formatter) triples.
    """
    print(f"\n\n{'=' * 78}\n{title}\n{'=' * 78}")
    for s in summary:
        cells = [f"{s['provider']:12s} {s['model']:46s}"]
        for header, key, fmt in columns:
            value = s.get(key)
            cells.append(f"{header}={fmt(value) if value is not None else 'n/a':>8s}")
        print("  " + "  ".join(cells))
