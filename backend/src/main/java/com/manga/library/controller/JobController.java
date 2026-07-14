package com.manga.library.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.model.Job;
import com.manga.library.repository.JobRepository;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.SseService;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/jobs")
@RequiredArgsConstructor
public class JobController {

  private final JobRepository jobRepository;
  private final JobCoordinatorService jobCoordinatorService;
  private final StringRedisTemplate redisTemplate;
  private final SseService sseService;
  private final ObjectMapper objectMapper;

  private static final String QUEUE_PAUSED_KEY = "system:queue:paused";

  @GetMapping
  public ResponseEntity<Map<String, Object>> getJobs() {
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
    redisTemplate.opsForValue().set(QUEUE_PAUSED_KEY, "true");
    sseService.emitEventToAllUsers("queue_paused", Map.of("event", "queue_paused"));
    return ResponseEntity.ok().build();
  }

  @PostMapping("/resume")
  public ResponseEntity<?> resumeQueue() {
    redisTemplate.opsForValue().set(QUEUE_PAUSED_KEY, "false");
    jobCoordinatorService.requeuePendingJobs();
    sseService.emitEventToAllUsers("queue_resumed", Map.of("event", "queue_resumed"));
    return ResponseEntity.ok().build();
  }

  @DeleteMapping("/clear")
  @org.springframework.transaction.annotation.Transactional
  public ResponseEntity<?> clearQueue() {
    try {
      List<Job> jobsToClear =
          jobRepository.findByStatusInOrderByCreatedAtAsc(List.of("PENDING", "PAUSED", "FAILED"));
      jobRepository.deleteAll(jobsToClear);

      // Clear Redis queues
      redisTemplate.delete(
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
              "queue:region-redo-tl"));

      sseService.emitEventToAllUsers(
          "queue_cleared", Map.of("event", "queue_cleared", "clearedCount", jobsToClear.size()));

      return ResponseEntity.ok().build();
    } catch (Exception e) {
      return ResponseEntity.internalServerError()
          .body(Map.of("error", e.getMessage() != null ? e.getMessage() : e.toString()));
    }
  }

  @PostMapping("/{id}/retry")
  public ResponseEntity<?> retryJob(@PathVariable String id) {
    return jobRepository
        .findById(id)
        .map(
            job -> {
              job.setStatus("PENDING");
              job.setError(null);
              job.setAttempt(1);
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
    return jobRepository
        .findById(id)
        .map(
            job -> {
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
    return jobRepository
        .findById(id)
        .map(
            job -> {
              if ("PAUSED".equals(job.getStatus())) {
                job.setStatus("PENDING");
                jobRepository.save(job);

                String paused = redisTemplate.opsForValue().get(QUEUE_PAUSED_KEY);
                if (!"true".equals(paused)) {
                  jobCoordinatorService.pushJobToRedis(job);
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
    return jobRepository
        .findById(id)
        .map(
            job -> {
              jobRepository.delete(job);
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
