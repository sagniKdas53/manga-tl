package com.manga.library.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.model.Job;
import com.manga.library.repository.JobRepository;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.SseService;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(JobController.class)
@AutoConfigureMockMvc(addFilters = false)
@SuppressWarnings({"null", "unchecked"})
public class JobControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private JobRepository jobRepository;
  @MockBean private JobCoordinatorService jobCoordinatorService;
  @MockBean private StringRedisTemplate redisTemplate;
  @MockBean private JwtAuthFilter jwtAuthFilter;
  @MockBean private SseService sseService;

  @Test
  public void testGetJobs() throws Exception {
    Job job = Job.builder().id("job1").type("ocr").status("PENDING").build();
    when(jobRepository.findByStatusInOrderByCreatedAtAsc(any())).thenReturn(List.of(job));

    ValueOperations<String, String> valOps = mock(ValueOperations.class);
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("system:queue:paused")).thenReturn("false");

    mockMvc
        .perform(get("/api/jobs"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.isPaused").value(false))
        .andExpect(jsonPath("$.jobs[0].id").value("job1"))
        .andExpect(jsonPath("$.jobs[0].type").value("ocr"))
        .andExpect(jsonPath("$.jobs[0].status").value("PENDING"));
  }

  @Test
  public void testClearQueue() throws Exception {
    Job job1 = Job.builder().id("job1").type("ocr").status("FAILED").build();
    Job job2 = Job.builder().id("job2").type("ocr").status("PENDING").build();
    when(jobRepository.findByStatusInOrderByCreatedAtAsc(any())).thenReturn(List.of(job1, job2));

    mockMvc.perform(delete("/api/jobs/clear")).andExpect(status().isOk());

    verify(jobRepository).deleteAll(List.of(job1, job2));
    verify(redisTemplate).delete(anyList());
  }

  @Test
  public void testPauseQueue() throws Exception {
    ValueOperations<String, String> valOps = mock(ValueOperations.class);
    when(redisTemplate.opsForValue()).thenReturn(valOps);

    mockMvc.perform(post("/api/jobs/pause")).andExpect(status().isOk());

    verify(valOps).set("system:queue:paused", "true");
  }

  @Test
  public void testResumeQueue() throws Exception {
    ValueOperations<String, String> valOps = mock(ValueOperations.class);
    when(redisTemplate.opsForValue()).thenReturn(valOps);

    mockMvc.perform(post("/api/jobs/resume")).andExpect(status().isOk());

    verify(valOps).set("system:queue:paused", "false");
    verify(jobCoordinatorService).requeuePendingJobs();
  }

  @Test
  public void testRetryJob() throws Exception {
    Job job = Job.builder().id("job1").type("ocr").status("FAILED").build();
    when(jobRepository.findById("job1")).thenReturn(Optional.of(job));

    ValueOperations<String, String> valOps = mock(ValueOperations.class);
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("system:queue:paused")).thenReturn("false");

    mockMvc.perform(post("/api/jobs/job1/retry")).andExpect(status().isOk());

    verify(jobRepository).save(any(Job.class));
    verify(jobCoordinatorService).pushJobToRedis(any(Job.class));
  }

  @Test
  public void testPauseJob() throws Exception {
    Job job = Job.builder().id("job1").type("ocr").status("PENDING").build();
    when(jobRepository.findById("job1")).thenReturn(Optional.of(job));

    mockMvc.perform(post("/api/jobs/job1/pause")).andExpect(status().isOk());

    verify(jobRepository).save(any(Job.class));
  }

  @Test
  public void testResumeJob() throws Exception {
    Job job = Job.builder().id("job1").type("ocr").status("PAUSED").build();
    when(jobRepository.findById("job1")).thenReturn(Optional.of(job));

    ValueOperations<String, String> valOps = mock(ValueOperations.class);
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("system:queue:paused")).thenReturn("false");

    mockMvc.perform(post("/api/jobs/job1/resume")).andExpect(status().isOk());

    verify(jobRepository).save(any(Job.class));
    verify(jobCoordinatorService).pushJobToRedis(any(Job.class));
  }

  @Test
  public void testDeleteJob() throws Exception {
    Job job = Job.builder().id("job1").type("ocr").status("PENDING").build();
    when(jobRepository.findById("job1")).thenReturn(Optional.of(job));

    mockMvc.perform(delete("/api/jobs/job1")).andExpect(status().isOk());

    verify(jobRepository).delete(job);
  }
}
