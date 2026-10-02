#!/usr/bin/env bash
# Run fresh current-checkout pipeline stages for every A09 roster and reserve page.
# Writes artifacts under the run directory; never overwrites in-place corpus artifacts.
set -uo pipefail

RUN_DIR="${RUN_DIR:-docs/quality-runs/a09-20260913-stages}"
LIST="${LIST:-$RUN_DIR/run-list.json}"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$LOG_DIR"

status_file="$RUN_DIR/stage-status.jsonl"
: >"$status_file"

total=$(jq length "$LIST")
index=0
while read -r row; do
  index=$((index + 1))
  dir=$(jq -r '.dir' <<<"$row")
  sample_id=$(jq -r '.sample_id' <<<"$row")
  role=$(jq -r '.role' <<<"$row")
  started=$(date -Is)
  echo "[$index/$total] $sample_id ($role)"
  if node scripts/playwright/export_pending.cjs \
      --pending-dir "$dir" \
      --out "$RUN_DIR/pages" \
      --shard a09 \
      --force \
      --base "$TLHUB_BASE" \
      --email "$TLHUB_EMAIL" \
      --password "$TLHUB_PASSWORD" >"$LOG_DIR/$sample_id.log" 2>&1; then
    result=ok
  else
    result=failed
  fi
  jq -nc --arg id "$sample_id" --arg role "$role" --arg dir "$dir" \
     --arg result "$result" --arg started "$started" --arg ended "$(date -Is)" \
     '{sample_id:$id, role:$role, dir:$dir, result:$result, started:$started, ended:$ended}' \
     >>"$status_file"
done < <(jq -c '.[]' "$LIST")

echo "done: $(grep -c '"result":"ok"' "$status_file") ok, $(grep -c '"result":"failed"' "$status_file") failed"
