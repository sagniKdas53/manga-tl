package com.manga.library.controller;

import com.manga.library.model.Job;
import com.manga.library.repository.JobRepository;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.SseService;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/jobs")
public class JobController {

  private final JobRepository jobRepository;
  private final JobCoordinatorService jobCoordinatorService;
  private final StringRedisTemplate redisTemplate;
  private final SseService sseService;

  public JobController(
      JobRepository jobRepository,
      JobCoordinatorService jobCoordinatorService,
      StringRedisTemplate redisTemplate,
      SseService sseService) {
    this.jobRepository = jobRepository;
    this.jobCoordinatorService = jobCoordinatorService;
    this.redisTemplate = redisTemplate;
    this.sseService = sseService;
  }

  private static final String QUEUE_PAUSED_KEY = "system:queue:paused";
  private static final org.slf4j.Logger log =
      org.slf4j.LoggerFactory.getLogger(JobController.class);

  @GetMapping
  public ResponseEntity<Map<String, Object>> getJobs() {
    log.debug("Heartbeat ping received from client");
    // Return jobs that are not COMPLETED
    List<Job> jobs =
        jobRepository.findByStatusInOrderByCreatedAtAsc(
            List.of("PENDING", "PROCESSING", "FAILED", "PAUSED"));

    String paused = redisTemplate.opsForValue().get(QUEUE_PAUSED_KEY);
    boolean isPaused = "true".equals(paused);

    Map<String, Object> response = new HashMap<>();
    response.put("jobs", jobs);
    response.put("isPaused", isPaused);

    return ResponseEntity.ok(response);
  }

  @PostMapping("/pause")
  public ResponseEntity<?> pauseQueue() {
    log.info("Queue PAUSED via API");
    redisTemplate.opsForValue().set(QUEUE_PAUSED_KEY, "true");
    sseService.emitEventToAllUsers("queue_paused", Map.of("event", "queue_paused"));
    return ResponseEntity.ok().build();
  }

  @PostMapping("/resume")
  public ResponseEntity<?> resumeQueue() {
    log.info("Queue RESUMED via API — re-queuing PENDING jobs");
    redisTemplate.opsForValue().set(QUEUE_PAUSED_KEY, "false");
    jobCoordinatorService.requeuePendingJobs();
    sseService.emitEventToAllUsers("queue_resumed", Map.of("event", "queue_resumed"));
    return ResponseEntity.ok().build();
  }

  @DeleteMapping("/clear")
  @org.springframework.transaction.annotation.Transactional
  public ResponseEntity<?> clearQueue(
      @RequestParam(required = false, defaultValue = "false") boolean force) {
    try {
      List<String> statusesToClear = force
          ? List.of("PENDING", "PAUSED", "FAILED", "PROCESSING")
          : List.of("PENDING", "PAUSED", "FAILED");

      List<Job> jobsToClear =
          jobRepository.findByStatusInOrderByCreatedAtAsc(statusesToClear);
      log.info(
          "Clearing queue via API (force={}): removing {} jobs with statuses {}",
          force,
          jobsToClear.size(),
          statusesToClear);
      jobRepository.deleteAll(java.util.Objects.requireNonNull(jobsToClear));

      // Clear Redis queues
      redisTemplate.delete(
          java.util.Objects.requireNonNull(
              List.of(
                  "queue:panel-detection",
                  "queue:ocr",
                  "queue:layout",
                  "queue:translation",
                  "queue:render",
                  "queue:qa",
                  "queue:qa-re-ocr",
                  "queue:region-redo",
                  "queue:region-redo-ocr",
                  "queue:region-redo-tl")));

      sseService.emitEventToAllUsers(
          "queue_cleared",
          Map.of("event", "queue_cleared", "clearedCount", jobsToClear.size(), "force", force));

      return ResponseEntity.ok().build();
    } catch (Exception e) {
      return ResponseEntity.internalServerError()
          .body(Map.of("error", e.getMessage() != null ? e.getMessage() : e.toString()));
    }
  }

  @PostMapping("/{id}/retry")
  public ResponseEntity<?> retryJob(@PathVariable String id) {
    java.util.Objects.requireNonNull(id, "id cannot be null");
    return jobRepository
        .findById(id)
        .map(
            job -> {
              job.setStatus("PENDING");
              job.setError(null);
              job.setAttempt(1);
              log.info(
                  "Retrying job {} (type={}, imageId={}) — resetting to PENDING, attempt=1",
                  job.getId(),
                  job.getType(),
                  job.getImageId());
              jobRepository.save(job);

              // Push to Redis if not paused
              String paused = redisTemplate.opsForValue().get(QUEUE_PAUSED_KEY);
              if (!"true".equals(paused)) {
                jobCoordinatorService.pushJobToRedis(job);
              }

              emitJobUpdateEvent(job);
              return ResponseEntity.ok().build();
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/{id}/pause")
  public ResponseEntity<?> pauseJob(@PathVariable String id) {
    java.util.Objects.requireNonNull(id, "id cannot be null");
    return jobRepository
        .findById(id)
        .map(
            job -> {
              log.info(
                  "Pausing job {} (type={}, imageId={})",
                  job.getId(),
                  job.getType(),
                  job.getImageId());
              if ("PENDING".equals(job.getStatus())) {
                job.setStatus("PAUSED");
                jobRepository.save(job);
                emitJobUpdateEvent(job);
                return ResponseEntity.ok().build();
              }
              return ResponseEntity.badRequest().body("Only PENDING jobs can be paused");
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/{id}/resume")
  public ResponseEntity<?> resumeJob(@PathVariable String id) {
    java.util.Objects.requireNonNull(id, "id cannot be null");
    return jobRepository
        .findById(id)
        .map(
            job -> {
              log.info(
                  "Resuming job {} (type={}, imageId={})",
                  job.getId(),
                  job.getType(),
                  job.getImageId());
              if ("PAUSED".equals(job.getStatus())) {
                job.setStatus("PENDING");
                jobRepository.save(job);

                String paused = redisTemplate.opsForValue().get(QUEUE_PAUSED_KEY);
                if (!"true".equals(paused)) {
                  jobCoordinatorService.pushJobToRedis(job);
                  log.debug("Job {} re-pushed to Redis queue", job.getId());
                } else {
                  log.debug(
                      "Job {} held in DB (queue globally paused) — not re-pushed to Redis",
                      job.getId());
                }
                emitJobUpdateEvent(job);
                return ResponseEntity.ok().build();
              }
              return ResponseEntity.badRequest().body("Only PAUSED jobs can be resumed");
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/{id}")
  public ResponseEntity<?> deleteJob(@PathVariable String id) {
    java.util.Objects.requireNonNull(id, "id cannot be null");
    return jobRepository
        .findById(id)
        .map(
            job -> {
              log.info(
                  "Deleting job {} (type={}, status={}, imageId={})",
                  job.getId(),
                  job.getType(),
                  job.getStatus(),
                  job.getImageId());
              jobRepository.delete(java.util.Objects.requireNonNull(job));
              Map<String, Object> deletedJobData = new HashMap<>();
              deletedJobData.put("jobId", job.getId());
              deletedJobData.put("status", "DELETED");
              sseService.emitEventForImage(job.getImageId(), "job_update", deletedJobData);
              return ResponseEntity.ok().build();
            })
        .orElse(ResponseEntity.notFound().build());
  }

  private void emitJobUpdateEvent(Job job) {
    try {
      sseService.emitEventForImage(job.getImageId(), "job_update", job);
    } catch (Exception e) {
      System.err.println("Failed to emit job update event: " + e.getMessage());
    }
  }
}
