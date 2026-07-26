#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [ -f "${ENV_FILE}" ]; then
  echo "[INFO] Loading secrets from ${ENV_FILE}..."
  set -a
  source "${ENV_FILE}"
  set +a
fi

API_KEY="${OPENAI_API_KEY:-${1:-}}"
MODEL="${2:-gpt-4o-mini}"

if [ -z "${API_KEY}" ]; then
  echo "[ERROR] OPENAI_API_KEY not set in ${ENV_FILE} or environment."
  exit 1
fi

echo "[INFO] Testing OpenAI with model '${MODEL}'..."

curl -i -X POST https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
  "model": "'"${MODEL}"'",
  "messages": [
    {
      "role": "system",
      "content": "You are an expert manga translator.\nTranslate the list of manga text regions into natural English.\nReturn ONLY valid JSON conforming to schema."
    },
    {
      "role": "user",
      "content": "Translate Japanese to English:\n[\n  {\"id\": \"1\", \"panel\": 1, \"bubble\": 1, \"regionType\": \"speech\", \"text\": \"一緒に浴びましょうよー洗ってあげますからぁ\"}\n]"
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "structured_output",
      "schema": {
        "type": "object",
        "properties": {
          "translations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": { "type": "string" },
                "translation": { "type": "string" }
              },
              "required": ["id", "translation"]
            }
          }
        },
        "required": ["translations"]
      },
      "strict": true
    }
  }
}'
echo ""
