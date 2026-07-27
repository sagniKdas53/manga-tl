Based on the logs @[logs/run-4.log] shouldn't the job have failed after exhausting it's retires why does it keep looping, also validate if rate limits are
  bing enforced correctly or not and finally check why manga-worker     | INFO:     172.18.0.6:50728 - "GET /capabilities HTTP/1.1" 200 OK is getting called so
  many times

---

Summary of Findings
Issue #1: Infinite Retry Loop
The root cause is confirmed. recoverStaleProcessingJobs() at line 107-128 resets status to PENDING and re-enqueues the job, but never increments the attempt field in either the DB or the JSON payload. The worker reads attempt from the payload (rq_tasks.py:122), so it always sees attempt=1 and never hits the max-attempts limit.
The stale recovery fires every 5 minutes (fixedRate = 300000), and after a 10-minute threshold, it re-enqueues the job. This creates an infinite loop.
Additionally, resetProcessingJobsToPending() (line 94) has the same bug — on container restart, it resets status without incrementing attempt.
Fix needed:

- In recoverStaleProcessingJobs() and resetProcessingJobsToPending(): read job.getAttempt(), increment it, update both DB and payload JSON, only re-enqueue if attempt < maxAttempts
- Same fix needed in requeuePendingJobs() (line 397) which also uses stale payloads
Issue #2: Rate Limit Enforcement
The worker's LLM client has tenacity retry with 6 attempts on429, but the provider cooldown default is only 5 seconds. The translation handler's per-region retry (translation.py:242-274) tries each failed region individually, each with its own retry loop. This creates an explosion of API calls.
The translation handler never raises an exception on failure — it marks regions failed and returns normally. So the job always gets COMPLETED status even when all translations fail.
Fix needed:
- Reduce tenacity retry attempts from 6 to 3
- Increase default cooldown to respect Retry-After header better
- Add a circuit breaker or max total retries per job
- Translation handler should raise on all-failed so the job fails properly
Issue #3: Excessive /capabilities Calls
WorkerDispatcherService.java:78 has @Scheduled(fixedDelay = 2000) — polls every 2 seconds regardless of queue state. This creates constant /capabilities requests even when idle.
Fix needed:
- Replace with event-driven approach: only check capabilities before job submission
- Or use a longer polling interval (30s) with shorter when queues are non-empty
Issue #4: Rate Limit Validation
Partially fixed — rateLimits in providers.json are validated against provider docs, but the actual enforcement is still broken per issue #2.

---
