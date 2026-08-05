package com.manga.library.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.model.Job;
import jakarta.annotation.PostConstruct;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class WorkerDispatcherService {
  private static final org.slf4j.Logger log =
      org.slf4j.LoggerFactory.getLogger(WorkerDispatcherService.class);

  @org.springframework.beans.factory.annotation.Value("${WORKER_URLS:http://worker:9091}")
  private String workerUrlsConfig;

  @org.springframework.beans.factory.annotation.Value("${WORKER_API_SECRET:}")
  private String workerApiSecret;

  @org.springframework.beans.factory.annotation.Value("${WORKER_API_SECRET_FILE:}")
  private String workerApiSecretFile;

  /** Base cooldown duration (seconds) after a 429 from a worker. Doubles each consecutive 429. */
  private static final int COOLDOWN_BASE_SECONDS = 10;

  private static final int COOLDOWN_MAX_SECONDS = 60;

  /** Per-worker state: cooldown expiry time. */
  private final Map<String, Instant> workerCooldowns = new ConcurrentHashMap<>();

  /** Per-worker consecutive 429 counter (for exponential backoff). */
  private final Map<String, Integer> workerConsecutive429s = new ConcurrentHashMap<>();

  @PostConstruct
  public void init() {
    if (workerApiSecretFile != null && !workerApiSecretFile.isEmpty()) {
      try {
        workerApiSecret = Files.readString(Path.of(workerApiSecretFile)).trim();
        log.info("Loaded WORKER_API_SECRET from file");
      } catch (Exception e) {
        log.error("Failed to read WORKER_API_SECRET_FILE", e);
      }
    }
  }

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;
  private final com.manga.library.repository.JobRepository jobRepository;
  private final SseService sseService;

  public WorkerDispatcherService(
      StringRedisTemplate redisTemplate,
      ObjectMapper objectMapper,
      com.manga.library.repository.JobRepository jobRepository,
      SseService sseService) {
    this.redisTemplate = redisTemplate;
    this.objectMapper = objectMapper;
    this.jobRepository = jobRepository;
    this.sseService = sseService;
  }

  private final HttpClient httpClient =
      HttpClient.newBuilder()
          .version(HttpClient.Version.HTTP_1_1)
          .connectTimeout(Duration.ofSeconds(3))
          .build();

  private final List<String> HEAVY_QUEUES =
      List.of("queue:qa-re-ocr", "queue:region-redo-ocr", "queue:ocr", "queue:panel-detection");

  private final List<String> LIGHT_QUEUES =
      List.of(
          "queue:region-redo-tl", "queue:qa", "queue:render", "queue:translation", "queue:layout");

  @Scheduled(fixedDelayString = "${WORKER_POLL_MS:2000}")
  public void dispatchJobs() {
    if (redisTemplate == null || redisTemplate.opsForValue() == null) {
      return;
    }
    String paused = redisTemplate.opsForValue().get("system:queue:paused");
    if ("true".equals(paused)) {
      log.debug("Queue is globally paused — skipping dispatch cycle");
      return;
    }

    List<String> workerUrls = buildWorkerUrlList();
    if (workerUrls.isEmpty()) {
      return;
    }

    if (!anyQueueHasItems()) {
      return;
    }

    Map<String, WorkerCapacity> capacities = queryCapacities(workerUrls);
    if (capacities.isEmpty()) {
      // All workers are in cooldown or unreachable — skip this cycle
      return;
    }

    dispatchFromSlot(HEAVY_QUEUES, workerUrls, capacities, true);
    dispatchFromSlot(LIGHT_QUEUES, workerUrls, capacities, false);
  }

  /** Returns a map of workerUrl → WorkerCapacity for workers that are available (not in cooldown). */
  private Map<String, WorkerCapacity> queryCapacities(List<String> workerUrls) {
    Map<String, WorkerCapacity> result = new LinkedHashMap<>();
    Instant now = Instant.now();
    for (String workerUrl : workerUrls) {
      // Skip workers in cooldown
      Instant cooldownExpiry = workerCooldowns.get(workerUrl);
      if (cooldownExpiry != null && now.isBefore(cooldownExpiry)) {
        log.debug("Worker {} is in cooldown until {}", workerUrl, cooldownExpiry);
        continue;
      }

      try {
        HttpRequest.Builder reqBuilder =
            HttpRequest.newBuilder()
                .uri(URI.create(workerUrl + "/capabilities"))
                .timeout(Duration.ofSeconds(3))
                .GET();
        if (workerApiSecret != null && !workerApiSecret.isEmpty()) {
          reqBuilder.header("WORKER_API_SECRET", workerApiSecret);
        }
        HttpResponse<String> resp =
            httpClient.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() == 200) {
          JsonNode node = objectMapper.readTree(resp.body());
          int maxJobs = node.path("max_concurrent_jobs").asInt(2);
          int activeJobs = node.path("active_jobs").asInt(0);
          int maxHeavy = node.path("max_heavy_slots").asInt(1);
          int activeHeavy = node.path("active_heavy_jobs").asInt(0);
          int maxLight = node.path("max_light_slots").asInt(1);
          int activeLight = node.path("active_light_jobs").asInt(0);
          result.put(workerUrl, new WorkerCapacity(maxJobs, activeJobs, maxHeavy, activeHeavy, maxLight, activeLight));
          // Clear consecutive 429 counter on successful ping
          workerConsecutive429s.remove(workerUrl);
        }
      } catch (Exception e) {
        log.debug("Worker {} capabilities query failed: {}", workerUrl, e.getMessage());
      }
    }
    return result;
  }

  private void dispatchFromSlot(
      List<String> queues,
      List<String> workerUrls,
      Map<String, WorkerCapacity> capacities,
      boolean isHeavy) {

    for (String queue : queues) {
      // Check if any worker has capacity for this slot type before popping
      boolean anyCapacity = capacities.values().stream()
          .anyMatch(c -> isHeavy ? c.hasHeavySlot() : c.hasLightSlot());
      if (!anyCapacity) {
        log.debug(
            "No free {} slot on any worker — throttling queue {}",
            isHeavy ? "heavy" : "light",
            queue);
        continue;
      }

      boolean processed = true;
      while (processed) {
        processed = false;

        String jobJson = redisTemplate.opsForList().leftPop(Objects.requireNonNull(queue));
        if (jobJson == null) continue;

        boolean sent = false;
        for (String workerUrl : workerUrls) {
          WorkerCapacity cap = capacities.get(workerUrl);
          if (cap == null) continue; // Worker in cooldown or unreachable
          if (isHeavy && !cap.hasHeavySlot()) continue;
          if (!isHeavy && !cap.hasLightSlot()) continue;

          try {
            String targetUrl = workerUrl + "/api/v1/jobs/submit";
            @SuppressWarnings("unchecked")
            Map<String, Object> jobData = objectMapper.readValue(jobJson, Map.class);

            // Logged on dispatch below. jobs has no dispatch timestamp, so this
            // line is the only way to tell a stage's queue wait apart from its
            // actual work: without it, updated_at - created_at is all we have and
            // it conflates the two. payload "jobId" is the jobs.id primary key
            // (JobCoordinatorService sets both from the same UUID), so a run's
            // backend.log joins directly to jobs.csv.
            String jobId = String.valueOf(jobData.getOrDefault("jobId", "unknown"));

            Map<String, Object> payload = new HashMap<>();
            payload.put("queue_name", queue);
            payload.put("job_data", jobData);

            String jsonBody = objectMapper.writeValueAsString(payload);

            HttpRequest.Builder requestBuilder =
                HttpRequest.newBuilder()
                    .uri(URI.create(targetUrl))
                    .timeout(Duration.ofSeconds(30))
                    .header("Content-Type", "application/json")
                    .POST(
                        HttpRequest.BodyPublishers.ofString(
                            jsonBody, java.nio.charset.StandardCharsets.UTF_8));

            if (workerApiSecret != null && !workerApiSecret.isEmpty()) {
              requestBuilder.header("WORKER_API_SECRET", workerApiSecret);
            }

            HttpResponse<String> response =
                httpClient.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 202) {
              sent = true;
              processed = true;
              // Update in-memory capacity so subsequent iterations see the new load
              if (isHeavy) cap.activeHeavy++;
              else cap.activeLight++;
              cap.activeTotal++;
              workerConsecutive429s.remove(workerUrl);
              log.info(
                  "Dispatched job {} from {} to worker {} (activeHeavy={}, activeLight={}, activeTotal={})",
                  jobId, queue, workerUrl, cap.activeHeavy, cap.activeLight, cap.activeTotal);
              break;
            } else if (response.statusCode() == 400 || response.statusCode() == 422) {
              // Permanent rejection — payload invalid; do not re-queue
              log.error(
                  "Worker {} permanently rejected job (status {}): {}",
                  targetUrl,
                  response.statusCode(),
                  response.body());
              sent = true; // prevent re-push to queue
              processed = true;
              markPermanentlyRejected(jobId, response.statusCode(), response.body());
              break;
            } else if (response.statusCode() == 429) {
              // Apply exponential backoff
              int consecutive =
                  workerConsecutive429s.merge(
                      workerUrl,
                      1,
                      (a, b) -> Integer.sum(Objects.requireNonNull(a), Objects.requireNonNull(b)));
              int cooldownSecs = Math.min(COOLDOWN_BASE_SECONDS * (1 << (consecutive - 1)), COOLDOWN_MAX_SECONDS);
              workerCooldowns.put(workerUrl, Instant.now().plusSeconds(cooldownSecs));
              log.warn(
                  "Worker {} returned 429 (consecutive={}). Cooling down for {}s.",
                  workerUrl, consecutive, cooldownSecs);
              // Remove from capacities map so we don't retry this worker in this cycle
              capacities.remove(workerUrl);
            } else {
              log.error(
                  "Worker {} returned status {}: {}",
                  targetUrl,
                  response.statusCode(),
                  response.body());
            }
          } catch (java.io.IOException | RuntimeException e) {
            log.debug("Worker {} is unreachable: {}", workerUrl, e.getMessage());
          } catch (InterruptedException e) {
            // Restore the flag: this runs on the shared scheduler thread, and swallowing the
            // interrupt outright would leave a shutting-down application still dispatching.
            Thread.currentThread().interrupt();
            log.debug("Interrupted while dispatching to worker {}", workerUrl);
          }
        }

        if (!sent) {
          // Re-push to the BACK of the queue so other jobs can proceed
          redisTemplate
              .opsForList()
              .rightPush(Objects.requireNonNull(queue), Objects.requireNonNull(jobJson));
          log.debug(
              "Job from {} not dispatched (worker rejected/unreachable) — pushed back to queue",
              queue);
          // AUDIT-P3: stop draining *this* queue, not the whole slot class. This used to be a
          // `return`, so one undispatchable job on queue:qa-re-ocr meant queue:ocr was not polled
          // at all that cycle.
          break;
        }
      }
    }
  }

  /**
   * Marks a permanently-rejected job FAILED (AUDIT-P2).
   *
   * <p>A 400/422 pops the job off Redis and sets {@code sent} so it is never re-pushed. Nothing used
   * to touch the DB row, so it stayed PENDING forever: {@code recoverStaleProcessingJobs} only scans
   * PROCESSING and never saw it, and {@code requeuePendingJobs} re-pushed it on the next backend
   * restart only to have it rejected again. The user-visible symptom was a pipeline that stopped at
   * a stage with no error anywhere in the UI.
   *
   * <p>Best-effort by design: the job is already off the queue, and a DB or SSE failure here must
   * not abort the rest of the dispatch cycle.
   */
  private void markPermanentlyRejected(String jobId, int statusCode, String body) {
    if (jobRepository == null || jobId == null || "unknown".equals(jobId)) {
      log.warn("Permanently rejected job has no usable jobId — cannot mark it FAILED");
      return;
    }
    try {
      Job job = jobRepository.findById(jobId).orElse(null);
      if (job == null) {
        log.warn("Permanently rejected job {} has no DB row to mark FAILED", jobId);
        return;
      }
      job.setStatus("FAILED");
      job.setError("Worker rejected the job payload (HTTP " + statusCode + "): " + truncate(body));
      job.setUpdatedAt(OffsetDateTime.now());
      jobRepository.save(job);
      if (sseService != null && job.getImageId() != null) {
        sseService.emitEventForImage(job.getImageId(), "job_update", job);
      }
      log.error("Marked job {} FAILED after a permanent worker rejection (HTTP {})", jobId, statusCode);
    } catch (RuntimeException e) {
      log.error("Failed to mark rejected job {} as FAILED: {}", jobId, e.getMessage());
    }
  }

  /** Keeps a verbose worker validation body out of the {@code jobs.error} column. */
  private static String truncate(String body) {
    if (body == null) return "";
    return body.length() <= 500 ? body : body.substring(0, 500) + "…";
  }

  private List<String> buildWorkerUrlList() {
    List<String> workerUrls = new ArrayList<>();
    if (workerUrlsConfig != null) {
      for (String url : workerUrlsConfig.split(",")) {
        String trimmed = url.trim();
        if (trimmed.endsWith("/")) {
          trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        if (!trimmed.isEmpty()) {
          workerUrls.add(trimmed);
        }
      }
    }
    return workerUrls;
  }

  /** Quick Redis check: are any work queues non-empty? Avoids expensive /capabilities calls. */
  private boolean anyQueueHasItems() {
    List<String> allQueues = new ArrayList<>();
    allQueues.addAll(HEAVY_QUEUES);
    allQueues.addAll(LIGHT_QUEUES);
    for (String q : allQueues) {
      Long size = redisTemplate.opsForList().size(Objects.requireNonNull(q));
      if (size != null && size > 0) return true;
    }
    return false;
  }

  /** Snapshot of a worker's current concurrency state. */
  private static class WorkerCapacity {
    final int maxTotal;
    int activeTotal;
    final int maxHeavy;
    int activeHeavy;
    final int maxLight;
    int activeLight;

    WorkerCapacity(int maxTotal, int activeTotal, int maxHeavy, int activeHeavy, int maxLight, int activeLight) {
      this.maxTotal = maxTotal;
      this.activeTotal = activeTotal;
      this.maxHeavy = maxHeavy;
      this.activeHeavy = activeHeavy;
      this.maxLight = maxLight;
      this.activeLight = activeLight;
    }

    boolean hasHeavySlot() {
      return activeHeavy < maxHeavy && activeTotal < maxTotal;
    }

    boolean hasLightSlot() {
      return activeLight < maxLight && activeTotal < maxTotal;
    }
  }
}
