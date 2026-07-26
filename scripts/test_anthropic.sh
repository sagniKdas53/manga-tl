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

API_KEY="${ANTHROPIC_API_KEY:-${1:-}}"
MODEL="${2:-claude-3-5-sonnet-20241022}"

if [ -z "${API_KEY}" ]; then
  echo "[ERROR] ANTHROPIC_API_KEY not set in ${ENV_FILE} or environment."
  exit 1
fi

echo "[INFO] Testing Anthropic with model '${MODEL}'..."

curl -i -X POST https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
  "model": "'"${MODEL}"'",
  "max_tokens": 4096,
  "system": [
    {
      "type": "text",
      "text": "You are an expert manga translator.\nTranslate the list of manga text regions into natural English.\nReturn ONLY valid JSON format."
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Translate Japanese to English:\n[\n  {\"id\": \"1\", \"panel\": 1, \"bubble\": 1, \"regionType\": \"speech\", \"text\": \"一緒に浴びましょうよー洗ってあげますからぁ\"}\n]"
    }
  ]
}'
echo ""
