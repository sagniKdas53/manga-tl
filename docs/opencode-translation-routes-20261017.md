# OpenCode as a translation route (2026-10-17)

Why we looked: buying OpenRouter credits by card from India adds about 5.5% fee (minimum $0.80)
and 18% GST, plus the card's own forex fee. Of the routes checked, only OpenCode was worth keeping.
This page records the two ways to use it: **with an API key** and **without one**.

The GST is a lawful tax. Any foreign seller of digital services to an Indian buyer is generally
meant to charge it, so switching providers probably does not remove it. What a switch can save is
OpenRouter's fee, and the free models.

## What was measured

All on the laptop, 2026-10-17, opencode v2.0.32.

| Test | Result |
|---|---|
| One short line, `opencode/deepseek-v4.1-flash-free` | 4.3 s, valid JSON |
| One short line, `opencode/mimo-v2.6-flash-free` | 7.6 s, valid JSON |
| Real page (`corpus/samples/ja/sample1`, image + `MANGA_TRANSLATION_JSON_SYSTEM_PROMPT` + 4 regions), DeepSeek V4.1 Flash Free | 12.3 s, valid JSON, good English. Not confirmed the model actually looked at the image. |
| Plain HTTP call to the free endpoint with **no key** | **HTTP 403** `FreeTierError`: "OpenCode's free tier can only be used from within OpenCode." |

For scale: across 4,868 logged worker calls, a call averages about 4.6k tokens in and 1.3k out, and
corpus pages cost about $0.007 each (median of 260 pages).

## Method 1: with an API key (preferred)

Get a key at <https://opencode.ai/console> (add billing and credits there). The API is
OpenAI-compatible, so the worker needs **no new code**, only a `config/providers.json` entry and
the key in an env var.

- Chat endpoint (DeepSeek, GLM, Qwen, MiniMax, Kimi, most free models):
  `https://opencode.ai/inference/openai/v1/chat/completions`
- Model list (public): `https://opencode.ai/inference/v1/models`
- Model ids go **without** the `opencode/` prefix the CLI uses, e.g. `glm-5.3-flash-free`.
- Card fee: 4.4% + $0.30 per top-up. Their docs say nothing about tax. Check at checkout.

Paid prices (per 1M tokens, from their docs on 2026-10-17):

| Model | In | Out | Cached in |
|---|---|---|---|
| DeepSeek V4.1 Flash | $0.30 | $1.20 | $0.006 |
| DeepSeek V4 Pro | $1.74 | $3.48 | $0.145 |
| MiMo | no paid MiMo listed | | |

These are not automatically cheaper than OpenRouter (which lists DeepSeek V4.1 Flash at
$0.003 / $2.40). The win is the free models and a smaller fee.

Sketch of the entry. Untested: the env var name, model ids and priority are placeholders.

```json
"opencode": {
  "displayName": "OpenCode",
  "type": "openai-compatible",
  "baseUrl": "https://opencode.ai/inference/openai/v1/chat/completions",
  "authHeader": "Authorization",
  "authPrefix": "Bearer ",
  "keyEnvVar": "OPENCODE_API_KEY",
  "freeTier": true,
  "priority": 2,
  "models": {
    "tl": [
      { "id": "glm-5.3-flash-free", "name": "GLM-5.3-Flash (free, limited time)", "free": true },
      { "id": "deepseek-v4.1-flash-free", "name": "DeepSeek V4.1 Flash (free, limited time)", "free": true },
      { "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash" }
    ],
    "qaLLM": null, "qaVLM": null, "ocr": null
  },
  "defaultTLModel": "glm-5.3-flash-free"
}
```

`glm-5.3-flash` is already the worker's default translation model through OpenRouter, so the free
OpenCode copy should translate the same and cost nothing while the free period lasts.

**Open question to check first:** whether the free models answer an API-key call from the worker,
or only calls from the OpenCode app (the 403 above was a keyless call). Try one request with the
key before wiring anything.

## Method 2: without an API key (CLI only)

The free models work with no OpenCode login, but **only through OpenCode's own program**. Calling
the endpoint directly is refused (403 above). Do not try to make a direct call look like the CLI;
that is getting around their rule, not using it.

What works is running the CLI:

```sh
opencode run -m opencode/deepseek-v4.1-flash-free -f page.jpg "<system prompt + schema + regions>"
```

There is also `opencode serve --port N --hostname 127.0.0.1`, a password-protected HTTP server
(the password is printed at start-up; API docs at `/doc`) that could act as a bridge. It started
here, but its request API was **not** tried.

Before using this from the worker:

- `opencode run` runs a coding agent ("build") that can use tools on the files around it. Run it in
  an empty folder, or set up an agent with tools turned off.
- The worker image has no opencode. It would need installing in the image, or a bridge on the host.
- Each call starts a whole program, so it is slower than plain HTTP (4–12 s above).
- Their message ends "keep building", meaning the free tier is meant for coding inside OpenCode.
  Using it as a translation backend is a grey area. Fine for trying things by hand; prefer Method 1
  for the worker.

## Free models: privacy

From OpenCode's docs on 2026-10-17. Any corpus page may be explicit, so this matters.

| Model | Data |
|---|---|
| DeepSeek V4.1 Flash Free | not kept, not used for training |
| GLM-5.3-Flash Free | not kept, not used for training |
| MiMo-V2.6-Flash Free, MiMo-V2.5 Free | **may be used to improve the model** during the free period |
| Big Pickle | may be used to improve the model |
| Nemotron free models | "trial use only", usage logged |

All free models are "free for a limited time". Treat them as a bonus, not a cost plan; keep
OpenRouter as the fallback.

## Routes checked and rejected

So nobody re-investigates these:

- **Claude Code with a Pro/Max login in the worker.** Anthropic says subscription login is for
  "ordinary use of Claude Code and other native Anthropic applications". Products and services
  "should use API key authentication", and Anthropic may enforce this "without prior notice". The
  risk is the whole Claude account.
- **Codex with a ChatGPT login.** OpenAI names an API key as the option "for automation". It was
  also too slow: 37 s and 18,494 tokens of overhead for one short line.
- **Local models.** The laptop has a 2 GB GeForce 940MX and 2 cores, and chrome-box is older.
  Writing a page's ~1.3k output tokens would take minutes, against a 60 s limit.
- **Gemini free tier.** Free-tier prompts can be used for training, and Gemini already refuses some
  explicit pages.
- **NVIDIA API catalog.** Free for research and testing; production needs a paid licence.
- **Cerebras / Groq free tiers.** Unverified limits, a small free context, likely no images.
- **Paying OpenRouter by crypto** because it shows no tax line. That is avoiding a lawful tax. No.

Small savings that do not need any of this: a zero-forex card (removes the 1–3.5% card fee), and
fewer, bigger OpenRouter top-ups (the $0.80 minimum is about 16% of a $5 top-up).

## Sources

- OpenCode Zen docs: <https://opencode.ai/docs/zen/>
- Claude Code legal and compliance: <https://code.claude.com/docs/en/legal-and-compliance>
- Codex pricing: <https://learn.chatgpt.com/docs/pricing>
- OpenRouter limits: <https://openrouter.ai/docs/api-reference/limits>
- OpenRouter tax ID: <https://openrouter.ai/docs/cookbook/administration/tax-id>
- OpenRouter VAT/GST by card vs crypto: <https://checkout.rozo.ai/blog/openrouter-vat-gst-card-vs-crypto-checkout>
- NVIDIA forum on build.nvidia.com credits: <https://forums.developer.nvidia.com/t/api-credits-for-build-nvidia-com/306633/2>
