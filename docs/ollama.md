# Walkthrough - Remote Ollama Configuration and Verification

We have successfully configured and verified the remote Ollama service on `chrome-box` for both LLM and VLM tasks.

## Changes Made

### 1. Network Exposure (Completed by User)
- Updated the `ollama.service` systemd unit file on `chrome-box` to include `Environment="OLLAMA_HOST=0.0.0.0"`.
- Exposed Ollama on port `11434` to accept external network traffic.

### 2. Model Registration & Configuration
- **Gemma 4 (LLM):** Since `gemma4:latest` was already present on `chrome-box`, we created an alias using:
  ```bash
  ollama cp gemma4:latest gemma4:e4b
  ```
- **Qwen 2.5 VL (VLM):** We pulled the official `qwen2.5vl:3b` model from the registry on `chrome-box` and registered/aliased it to match your worker's settings:
  ```bash
  ollama pull qwen2.5vl:3b
  ollama cp qwen2.5vl:3b qwen2.5-vl-3b-instruct
  ```

---

## Verification Results

We verified that both models are reachable and loaded correctly from `ideapad` by querying the `/v1/chat/completions` API on `chrome-box.tail9ece4.ts.net:11434`:

### Gemma 4 (`gemma4:e4b`)
- **Status:** Reachable & Loaded
- **Response:**
  ```json
  {
    "id": "chatcmpl-645",
    "object": "chat.completion",
    "created": 1783236766,
    "model": "gemma4:e4b",
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "Hello! 👋"
        },
        "finish_reason": "stop"
      }
    ]
  }
  ```

### Qwen 2.5 VL (`qwen2.5-vl-3b-instruct`)
- **Status:** Reachable & Loaded
- **Response:**
  ```json
  {
    "id": "chatcmpl-66",
    "object": "chat.completion",
    "created": 1783236790,
    "model": "qwen2.5-vl-3b-instruct",
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "Hello! How can I assist you today? Is"
        },
        "finish_reason": "length"
      }
    ]
  }
  ```
