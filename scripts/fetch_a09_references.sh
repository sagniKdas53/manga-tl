#!/usr/bin/env bash
# Fetch a Torii English reference for every A09 page that has no human translation.
set -uo pipefail
LIST="${LIST:-docs/quality-runs/a09-20260913-stages/torii-list.txt}"
LOG_DIR="${LOG_DIR:-docs/quality-runs/a09-20260913-stages/torii-logs}"
STATUS="${STATUS:-docs/quality-runs/a09-20260913-stages/torii-status.jsonl}"
mkdir -p "$LOG_DIR"
: >"$STATUS"
cd corpus
while read -r sample; do
  [ -z "$sample" ] && continue
  id=$(basename "$sample")
  if ../.venv/bin/python scripts/fetch_torii.py --sample "$sample" \
       --translator "${TORII_TRANSLATOR:-gpt-5.6-luna}" --byok openrouter \
       >"../$LOG_DIR/$id.log" 2>&1; then
    result=ok
  else
    result=failed
  fi
  jq -nc --arg id "$id" --arg sample "$sample" --arg result "$result" --arg at "$(date -Is)" \
     '{sample_id:$id, sample:$sample, result:$result, at:$at}' >>"../$STATUS"
  echo "$id: $result"
  sleep 1.2
done <"../$LIST"
echo "torii done: $(grep -c '"result":"ok"' "../$STATUS") ok, $(grep -c '"result":"failed"' "../$STATUS") failed"
