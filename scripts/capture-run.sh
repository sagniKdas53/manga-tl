#!/usr/bin/env bash
# capture-run.sh — record everything needed for a pipeline performance analysis.
#
#   ./scripts/capture-run.sh start     # begin recording, then do your e2e run in the UI
#   ./scripts/capture-run.sh stop      # end recording, dump job timings, print a summary
#   ./scripts/capture-run.sh status    # is a capture running?
#
# Output lands in logs/runs/<timestamp>/ (logs/ is gitignored, so nothing large is
# ever committed). Drop your Firefox profile .json.gz into that same directory
# before handing the run off — see docs/perf_run_playbook.md.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

RUNS_DIR="logs/runs"
CURRENT_LINK="$RUNS_DIR/current"

DB_CONTAINER="manga-db"
BACKEND_CONTAINER="manga-backend"
WORKER_CONTAINER="manga-worker"
REDIS_CONTAINER="manga-valkey"

QUEUES=(
  queue:panel-detection queue:ocr queue:layout queue:translation
  queue:render queue:qa queue:qa-re-ocr queue:region-redo-ocr queue:region-redo-tl
)

pg_user() { grep -oP '(?<=^POSTGRES_USER=).*' .env 2>/dev/null || echo postgres; }
pg_db()   { grep -oP '(?<=^POSTGRES_DB=).*' .env 2>/dev/null || echo manga_library; }

# Runs a query and prints its rows. Unlike the original, this does NOT swallow
# stderr: a malformed query used to fail silently and leave a header-only CSV
# behind, which is indistinguishable from "the run genuinely had no rows".
# Errors now go to the terminal AND to sql_errors.log in the run directory.
psql_q() {
  local out rc
  out="$(docker exec "$DB_CONTAINER" psql -U "$(pg_user)" -d "$(pg_db)" \
          -v ON_ERROR_STOP=1 -tA -F',' -c "$1" 2>&1)"
  rc=$?
  if (( rc != 0 )); then
    echo "!! psql failed (rc=$rc): ${out}" >&2
    if [[ -n "${RUN_DIR:-}" ]]; then
      { echo "--- query ---"; echo "$1"; echo "--- error ---"; echo "$out"; echo; } \
        >> "$RUN_DIR/sql_errors.log"
    fi
    SQL_FAILURES=$(( ${SQL_FAILURES:-0} + 1 ))
    return "$rc"
  fi
  printf '%s\n' "$out"
}

# ----------------------------------------------------------------------------- start

cmd_start() {
  if [[ -L "$CURRENT_LINK" && -f "$CURRENT_LINK/pids" ]]; then
    echo "A capture is already running in $(readlink -f "$CURRENT_LINK")."
    echo "Run './scripts/capture-run.sh stop' first."
    exit 1
  fi

  local stamp run
  stamp="$(date +%Y%m%d-%H%M%S)"
  run="$RUNS_DIR/$stamp"
  mkdir -p "$run"
  ln -sfn "$stamp" "$CURRENT_LINK"
  RUN_DIR="$run"; SQL_FAILURES=0

  date -u +%Y-%m-%dT%H:%M:%SZ > "$run/started_at"

  echo "==> Capturing to $run"

  # Playbook section 1 says start from empty queues. Runs that ignored this
  # inherited a backlog (one started 16-deep on queue:layout), which makes queue
  # depths and dispatch decisions impossible to attribute. Warn, don't block.
  local preexisting
  preexisting="$(redis_queue_depths_total 2>/dev/null || echo 0)"
  if [[ "${preexisting:-0}" -gt 0 ]]; then
    echo "!! WARNING: ${preexisting} job(s) already queued before this run started."
    echo "!!          Queue depths in queues.csv will include carried-in work."
    echo "!! WARNING: pre-existing queue depth ${preexisting} at start" >> "$run/warnings.log"
  fi

  # --- environment snapshot (so the next session knows what was running) -------
  {
    echo "# Run environment — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo
    echo "## git"
    echo "commit: $(git rev-parse HEAD 2>/dev/null)"
    echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
    echo "dirty:"
    git status --porcelain 2>/dev/null | sed 's/^/  /'
    echo
    echo "## host"
    echo "cpus: $(nproc 2>/dev/null)"
    echo "mem: $(free -h 2>/dev/null | awk '/^Mem:/{print $2}')"
    echo
    echo "## containers"
    docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null
    echo
    echo "## worker capabilities"
    worker_capabilities
    echo
    echo "## perf-relevant env (secrets redacted)"
    grep -E '^(WORKER_POLL_MS|CONCURRENT_JOBS|MAX_HEAVY_SLOTS|MAX_LIGHT_SLOTS|REUSE_IDLE_SLOTS|RATE_LIMIT|OCR_MODEL_PROVIDER|OCR_VLM_MODEL|TL_MODEL_PROVIDER|TL_LLM_MODEL|QA_MODEL_PROVIDER|QA_LLM_MODEL|QA_VLM_MODEL|QA_MODE|LOCAL_LLM_|DISABLE_|PADDLEOCR_|LOG_LEVEL)' .env 2>/dev/null
    echo
    echo "## providers.json tasks"
    python3 -c "
import json
d=json.load(open('config/providers.json'))
for p,v in d.get('providers',{}).items():
    print(f\"  {p}: tasks={list(v.get('models',{}).keys())} priority={v.get('priority')} rate_limits={v.get('rateLimits')}\")
" 2>/dev/null
    echo
    # The env block above is the CONFIGURED intent, not what actually ran: model
    # choice is resolved from DB settings / providers.json at dispatch time. In
    # the 2026-08-01 runs the env said qwen3-vl-32b + deepseek-v4-pro while 114
    # of 116 real calls went to openai/gpt-5.6-luna. Record the effective values.
    echo "## effective settings (system_settings — this is what actually runs)"
    psql_q "SELECT '  '||setting_key||' = '||setting_value
              FROM system_settings
             ORDER BY setting_key;" \
      || echo "  (system_settings not readable — see sql_errors.log)"
  } > "$run/environment.md"

  # --- baseline DB counts ------------------------------------------------------
  psql_q "SELECT relname||'='||n_live_tup FROM pg_stat_user_tables ORDER BY relname;" \
    > "$run/db_counts_before.csv"

  # --- container logs (follow, with timestamps) --------------------------------
  # NB: the trailing Z is load-bearing. Without it `docker logs --since` reads the
  # value as *local* time, so a UTC-generated stamp reaches back by the UTC offset
  # and drags hours of unrelated backbuffer into the capture.
  local since
  since="$(date -u +%Y-%m-%dT%H:%M:%S)"
  echo "$since" > "$run/log_since"

  # Every background job below is fully detached from this shell's stdin/stdout.
  # Without that, the inherited fds stay open and `capture-run.sh start | tee`
  # (or any pipe) blocks forever waiting for EOF instead of returning.
  docker logs -f --timestamps --since "${since}Z" "$BACKEND_CONTAINER" \
    > "$run/backend.log" 2>&1 < /dev/null &
  local backend_pid=$!
  disown "$backend_pid" 2>/dev/null

  docker logs -f --timestamps --since "${since}Z" "$WORKER_CONTAINER" \
    > "$run/worker.log" 2>&1 < /dev/null &
  local worker_pid=$!
  disown "$worker_pid" 2>/dev/null

  # --- queue depth + slot occupancy sampler (2s) -------------------------------
  sample_queues "$run" > /dev/null 2>&1 < /dev/null &
  local queue_pid=$!
  disown "$queue_pid" 2>/dev/null

  # --- resource sampler (docker stats is slow, so it gets its own loop) --------
  sample_resources "$run" > /dev/null 2>&1 < /dev/null &
  local res_pid=$!
  disown "$res_pid" 2>/dev/null

  printf '%s\n' "$backend_pid" "$worker_pid" "$queue_pid" "$res_pid" > "$run/pids"

  cat <<EOF

    Recording started.

      logs      $run/backend.log, $run/worker.log
      queues    $run/queues.csv        (2s: depth per queue + worker slots)
      resources $run/resources.csv     (10s: CPU/mem per container)

    Now:
      1. Start the Firefox Profiler   -> https://profiler.firefox.com  (see the playbook)
      2. Do your e2e run in the UI
      3. Save the profile as $run/firefox-profile.json.gz
      4. ./scripts/capture-run.sh stop

EOF
}

worker_capabilities() {
  docker exec "$BACKEND_CONTAINER" wget -qO- \
    --header="WORKER_API_SECRET: $(cat secrets/worker_api_secret.txt 2>/dev/null)" \
    http://worker:8000/capabilities 2>/dev/null
}

# Total depth across every queue, for the "are we starting clean?" check.
redis_queue_depths_total() {
  local lua='local n=0 for i,k in ipairs(KEYS) do n=n+redis.call("LLEN",k) end return n'
  docker exec "$REDIS_CONTAINER" valkey-cli eval "$lua" \
    "${#QUEUES[@]}" "${QUEUES[@]}" 2>/dev/null | tr -dc '0-9'
}

sample_queues() {
  local run="$1" out="$run/queues.csv"
  {
    printf 'ts'
    for q in "${QUEUES[@]}"; do printf ',%s' "${q#queue:}"; done
    printf ',active_jobs,active_heavy,active_light,total_depth,sample_ms\n'
  } > "$out"

  # One EVAL for all nine LLENs rather than nine `docker exec`s: each exec costs
  # ~100ms of host CPU, and at a 2s cadence that would be a measurable share of a
  # 4-core box — i.e. the sampler would distort the very numbers it is recording.
  local lua='local t={} for i,k in ipairs(KEYS) do t[i]=redis.call("LLEN",k) end return t'

  while true; do
    local ts total=0 line depths
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    line="$ts"
    depths="$(docker exec "$REDIS_CONTAINER" valkey-cli --no-raw eval "$lua" \
                "${#QUEUES[@]}" "${QUEUES[@]}" 2>/dev/null \
              | grep -oP '(?<=\) )[0-9]+' | tr '\n' ' ')"
    local i=0
    for q in "${QUEUES[@]}"; do
      i=$((i + 1))
      local n
      n="$(echo "$depths" | cut -d' ' -f"$i")"
      [[ "$n" =~ ^[0-9]+$ ]] || n=0
      line+=",$n"
      total=$((total + n))
    done
    # The /capabilities call is the slow part of a sample. Under a busy pipeline
    # it stretched the nominal 2s cadence out to 7-26s, so the one run that most
    # needed a fine-grained timeline got the coarsest one. Bound it, and record
    # how long the sample actually took so the analysis can spot degradation
    # instead of silently reading gaps as steady state.
    local caps aj ah al t_start t_end sample_ms
    t_start="$(date +%s%3N)"
    caps="$(timeout 1.5 bash -c "$(declare -f worker_capabilities); \
              BACKEND_CONTAINER='$BACKEND_CONTAINER' worker_capabilities" 2>/dev/null)"
    aj="$(printf '%s' "$caps" | grep -oP '(?<="active_jobs":)[0-9]+' | head -1)"
    ah="$(printf '%s' "$caps" | grep -oP '(?<="active_heavy_jobs":)[0-9]+' | head -1)"
    al="$(printf '%s' "$caps" | grep -oP '(?<="active_light_jobs":)[0-9]+' | head -1)"
    t_end="$(date +%s%3N)"
    sample_ms=$(( t_end - t_start ))
    line+=",${aj:-},${ah:-},${al:-},$total,$sample_ms"
    echo "$line" >> "$out"
    sleep 2
  done
}

sample_resources() {
  local run="$1" out="$run/resources.csv"
  echo 'ts,container,cpu_pct,mem_used,mem_pct' > "$out"
  while true; do
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' \
      "$BACKEND_CONTAINER" "$WORKER_CONTAINER" "$DB_CONTAINER" "$REDIS_CONTAINER" 2>/dev/null \
      | while IFS= read -r l; do echo "$ts,$l" >> "$out"; done
    sleep 10
  done
}

# ------------------------------------------------------------------------------ stop

cmd_stop() {
  if [[ ! -L "$CURRENT_LINK" ]]; then
    echo "No capture is running."
    exit 1
  fi
  local run
  run="$(readlink -f "$CURRENT_LINK")"
  # psql_q writes failing queries here instead of failing silently.
  RUN_DIR="$run"; SQL_FAILURES=0

  echo "==> Stopping capture in $run"
  if [[ -f "$run/pids" ]]; then
    # Kill children first — the samplers are bash subshells whose in-flight
    # `docker exec` would otherwise outlive the parent and keep appending.
    while read -r p; do
      [[ -n "$p" ]] || continue
      pkill -TERM -P "$p" 2>/dev/null
      kill -TERM "$p" 2>/dev/null
    done < "$run/pids"
    sleep 1
    while read -r p; do
      [[ -n "$p" ]] || continue
      pkill -KILL -P "$p" 2>/dev/null
      kill -KILL "$p" 2>/dev/null
    done < "$run/pids"
    rm -f "$run/pids"
  fi

  date -u +%Y-%m-%dT%H:%M:%SZ > "$run/stopped_at"
  local since; since="$(cat "$run/log_since" 2>/dev/null)"

  # --- per-job timings: the spine of the whole analysis ------------------------
  # NOTE: the window is (created OR updated) in-window, not created-only. A
  # created-only filter hides work the worker did during the run on jobs queued
  # by an earlier run, which made whole stages look like they never executed.
  # in_window tells the analysis which rows have a duration it can trust.
  echo "job_id,type,status,attempt,image_id,page_id,trace_id,created_at,updated_at,duration_s,in_window,error" \
    > "$run/jobs.csv"
  psql_q "
    SELECT id||','||type||','||status||','||COALESCE(attempt::text,'')||','||
           COALESCE(image_id::text,'')||','||COALESCE(page_id::text,'')||','||
           COALESCE(trace_id,'')||','||created_at||','||COALESCE(updated_at::text,'')||','||
           COALESCE(ROUND(EXTRACT(EPOCH FROM (updated_at - created_at))::numeric,2)::text,'')||','||
           CASE WHEN created_at >= '${since}Z'::timestamptz THEN 'full' ELSE 'carried-in' END||','||
           COALESCE(REPLACE(REPLACE(error,',',';'),E'\n',' '),'')
      FROM jobs
     WHERE created_at >= '${since}Z'::timestamptz
        OR updated_at >= '${since}Z'::timestamptz
     ORDER BY created_at;" >> "$run/jobs.csv"

  # --- per-stage aggregate ------------------------------------------------------
  # Only COMPLETED/FAILED jobs have a meaningful updated_at-created_at. Including
  # PENDING rows (updated_at == created_at) dragged every percentile toward zero,
  # so the percentiles below are computed over finished jobs only; n_unfinished
  # keeps the count that was previously hidden inside a misleading p50 of 0.00.
  echo "type,n,ok,failed,n_unfinished,p50_s,p95_s,max_s,total_s" > "$run/stage_summary.csv"
  psql_q "
    SELECT type||','||COUNT(*)||','||
           COUNT(*) FILTER (WHERE status='COMPLETED')||','||
           COUNT(*) FILTER (WHERE status='FAILED')||','||
           COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED'))||','||
           COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (updated_at-created_at)))
             FILTER (WHERE status IN ('COMPLETED','FAILED'))::numeric,2)::text,'')||','||
           COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (updated_at-created_at)))
             FILTER (WHERE status IN ('COMPLETED','FAILED'))::numeric,2)::text,'')||','||
           COALESCE(ROUND(MAX(EXTRACT(EPOCH FROM (updated_at-created_at)))
             FILTER (WHERE status IN ('COMPLETED','FAILED'))::numeric,2)::text,'')||','||
           COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (updated_at-created_at)))
             FILTER (WHERE status IN ('COMPLETED','FAILED'))::numeric,2)::text,'')
      FROM jobs
     WHERE created_at >= '${since}Z'::timestamptz
        OR updated_at >= '${since}Z'::timestamptz
     GROUP BY type ORDER BY type;" >> "$run/stage_summary.csv"

  # --- cost / token usage -------------------------------------------------------
  echo "provider,model,calls,prompt_tokens,completion_tokens,cost_usd" > "$run/costs.csv"
  psql_q "
    SELECT COALESCE(provider,'?')||','||COALESCE(model,'?')||','||
           COUNT(*)||','||COALESCE(SUM(prompt_tokens)::text,'0')||','||
           COALESCE(SUM(completion_tokens)::text,'0')||','||
           COALESCE(ROUND(SUM(estimated_cost)::numeric,6)::text,'0')
      FROM job_costs
     WHERE created_at >= '${since}Z'::timestamptz
     GROUP BY provider, model
     ORDER BY SUM(estimated_cost) DESC NULLS LAST;" >> "$run/costs.csv"

  psql_q "SELECT relname||'='||n_live_tup FROM pg_stat_user_tables ORDER BY relname;" \
    > "$run/db_counts_after.csv"

  # --- duplicate-work detector (AUDIT-P4: requeue while worker still running) ---
  # Header says subject_id, not page_id: jobs carry image_id and leave page_id
  # NULL, so this has always grouped by image. GROUP BY names the real columns —
  # grouping by ordinal 1 grouped by the concatenated output string instead.
  echo "subject_id,type,runs" > "$run/duplicate_jobs.csv"
  psql_q "
    SELECT COALESCE(page_id::text,image_id::text)||','||type||','||COUNT(*)
      FROM jobs
     WHERE (created_at >= '${since}Z'::timestamptz
            OR updated_at >= '${since}Z'::timestamptz)
       AND COALESCE(page_id, image_id) IS NOT NULL
     GROUP BY COALESCE(page_id::text,image_id::text), type
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC;" >> "$run/duplicate_jobs.csv"

  # --- stuck/zombie jobs (AUDIT-P2: dropped on 400/422, left PENDING forever) ---
  echo "status,n" > "$run/terminal_states.csv"
  psql_q "
    SELECT status||','||COUNT(*) FROM jobs
     WHERE created_at >= '${since}Z'::timestamptz
        OR updated_at >= '${since}Z'::timestamptz
     GROUP BY status ORDER BY COUNT(*) DESC;" >> "$run/terminal_states.csv"

  # --- log-derived signals ------------------------------------------------------
  {
    echo "# Log signals"
    echo
    echo "## Backend"
    # "Dispatched job <id> from queue:X" — the id was added 2026-08-02, so match around it.
    for pat in "Dispatched job .* from" "not dispatched" "permanently rejected" "returned 429" \
               "Cooling down" "No free .* slot" "Recovering stale" "exhausted max attempts" \
               "falling back to the first one" "DEBUG_TL"; do
      printf '  %-42s %s\n' "$pat" "$(grep -Ec "$pat" "$run/backend.log" 2>/dev/null | head -1)"
    done
    echo
    echo "## Worker"
    for pat in "Rate limit: Sleeping" "is on cooldown" "Attempting to acquire" \
               "Failed to acquire" "Timeout" "Rate limited \(429\)" "Estimated cost" \
               "Failed to parse" "Local AI connection failed" "Traceback"; do
      printf '  %-42s %s\n' "$pat" "$(grep -Ec "$pat" "$run/worker.log" 2>/dev/null | head -1)"
    done
    echo
    echo "## Total sleep attributable to the global RATE_LIMIT (AUDIT-W2)"
    grep -oP '(?<=Rate limit: Sleeping for )[0-9.]+' "$run/worker.log" 2>/dev/null \
      | awk '{s+=$1} END {printf "  %.1f s across %d sleeps\n", s+0, NR+0}'
  } > "$run/log_signals.md"

  # --- wall clock ---------------------------------------------------------------
  local t0 t1 elapsed
  t0="$(date -d "$(cat "$run/started_at")" +%s 2>/dev/null)"
  t1="$(date -d "$(cat "$run/stopped_at")" +%s 2>/dev/null)"
  elapsed=$((t1 - t0))
  echo "$elapsed" > "$run/elapsed_seconds"

  gzip -f "$run/backend.log" "$run/worker.log" 2>/dev/null

  # --- did the pipeline actually drain? -----------------------------------------
  # Playbook section 4 says let it go idle before stopping. None of the
  # 2026-08-01 runs did, which left whole stages with unfinished jobs and made a
  # per-page end-to-end budget underivable. Say so loudly rather than at analysis
  # time, when it is too late to re-record.
  local left_queued unfinished
  left_queued="$(redis_queue_depths_total 2>/dev/null || echo '?')"
  unfinished="$(awk -F',' 'NR>1 && $3!="COMPLETED" && $3!="FAILED"' "$run/jobs.csv" 2>/dev/null | wc -l)"

  cat <<EOF

    Capture complete: $run  (wall clock: $((elapsed / 60))m $((elapsed % 60))s)

$(cat "$run/stage_summary.csv" | column -s, -t | sed 's/^/      /')

    Duplicate (subject,type) job pairs: $(( $(wc -l < "$run/duplicate_jobs.csv") - 1 ))
    Files: $(ls -1 "$run" | wc -l)   Size: $(du -sh "$run" | cut -f1)
EOF

  if [[ "${SQL_FAILURES:-0}" -gt 0 ]]; then
    echo "    !! ${SQL_FAILURES} query/queries FAILED — see $run/sql_errors.log."
    echo "    !! The CSVs they feed are incomplete. Do not treat them as empty results."
  fi
  if [[ "$unfinished" -gt 0 || "${left_queued:-0}" -gt 0 ]]; then
    cat <<EOF
    !! NOT DRAINED: $unfinished job(s) still unfinished, $left_queued still queued.
    !!   Stage totals are truncated and no page has a complete stage chain, so a
    !!   per-page end-to-end time budget cannot be built from this run. For a
    !!   throughput baseline, re-run and let the pipeline go fully idle first.
EOF
  fi

  cat <<EOF

    Don't forget the Firefox profile(s) in that directory, then start the next
    chat with the prompt in docs/perf_run_playbook.md.

EOF
  rm -f "$CURRENT_LINK"
}

cmd_status() {
  if [[ -L "$CURRENT_LINK" && -f "$CURRENT_LINK/pids" ]]; then
    local run; run="$(readlink -f "$CURRENT_LINK")"
    echo "Recording since $(cat "$run/started_at") -> $run"
    echo "queue samples: $(( $(wc -l < "$run/queues.csv" 2>/dev/null || echo 1) - 1 ))"
    tail -1 "$run/queues.csv" 2>/dev/null
  else
    echo "No capture running."
  fi
}

case "${1:-}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *) echo "usage: $0 {start|stop|status}"; exit 1 ;;
esac
