package com.manga.library.controller;

import com.manga.library.model.Job;
import com.manga.library.repository.JobRepository;
import com.manga.library.service.JobCoordinatorService;
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

    private static final String QUEUE_PAUSED_KEY = "system:queue:paused";

    @GetMapping
    public ResponseEntity<List<Job>> getJobs() {
        // Return jobs that are not COMPLETED
        List<Job> jobs = jobRepository.findByStatusInOrderByCreatedAtAsc(
                List.of("PENDING", "PROCESSING", "FAILED", "PAUSED"));
        return ResponseEntity.ok(jobs);
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Boolean>> getQueueStatus() {
        String paused = redisTemplate.opsForValue().get(QUEUE_PAUSED_KEY);
        return ResponseEntity.ok(Map.of("isPaused", "true".equals(paused)));
    }

    @PostMapping("/pause")
    public ResponseEntity<?> pauseQueue() {
        redisTemplate.opsForValue().set(QUEUE_PAUSED_KEY, "true");
        return ResponseEntity.ok().build();
    }

    @PostMapping("/resume")
    public ResponseEntity<?> resumeQueue() {
        redisTemplate.opsForValue().set(QUEUE_PAUSED_KEY, "false");
        jobCoordinatorService.requeuePendingJobs();
        return ResponseEntity.ok().build();
    }

    @PostMapping("/{id}/retry")
    public ResponseEntity<?> retryJob(@PathVariable String id) {
        return jobRepository.findById(id).map(job -> {
            job.setStatus("PENDING");
            job.setError(null);
            job.setAttempt(1);
            jobRepository.save(job);
            
            // Push to Redis if not paused
            String paused = redisTemplate.opsForValue().get(QUEUE_PAUSED_KEY);
            if (!"true".equals(paused)) {
                jobCoordinatorService.pushJobToRedis(job);
            }
            return ResponseEntity.ok().build();
        }).orElse(ResponseEntity.notFound().build());
    }
    
    @PostMapping("/{id}/pause")
    public ResponseEntity<?> pauseJob(@PathVariable String id) {
        return jobRepository.findById(id).map(job -> {
            if ("PENDING".equals(job.getStatus())) {
                job.setStatus("PAUSED");
                jobRepository.save(job);
                return ResponseEntity.ok().build();
            }
            return ResponseEntity.badRequest().body("Only PENDING jobs can be paused");
        }).orElse(ResponseEntity.notFound().build());
    }
    
    @PostMapping("/{id}/resume")
    public ResponseEntity<?> resumeJob(@PathVariable String id) {
        return jobRepository.findById(id).map(job -> {
            if ("PAUSED".equals(job.getStatus())) {
                job.setStatus("PENDING");
                jobRepository.save(job);
                
                String paused = redisTemplate.opsForValue().get(QUEUE_PAUSED_KEY);
                if (!"true".equals(paused)) {
                    jobCoordinatorService.pushJobToRedis(job);
                }
                return ResponseEntity.ok().build();
            }
            return ResponseEntity.badRequest().body("Only PAUSED jobs can be resumed");
        }).orElse(ResponseEntity.notFound().build());
    }
    
    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteJob(@PathVariable String id) {
        return jobRepository.findById(id).map(job -> {
            jobRepository.delete(job);
            return ResponseEntity.ok().build();
        }).orElse(ResponseEntity.notFound().build());
    }
}
