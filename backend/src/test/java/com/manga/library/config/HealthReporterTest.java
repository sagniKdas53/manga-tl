package com.manga.library.config;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.Mockito.*;

import com.manga.library.repository.JobRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
@SuppressWarnings("null")
public class HealthReporterTest {

  @Mock private JobRepository jobRepository;
  @Mock private StringRedisTemplate redisTemplate;
  @Mock private ValueOperations<String, String> valueOps;

  private HealthReporter healthReporter;

  @BeforeEach
  public void setUp() {
    healthReporter = new HealthReporter();
    ReflectionTestUtils.setField(healthReporter, "jobRepository", jobRepository);
    ReflectionTestUtils.setField(healthReporter, "redisTemplate", redisTemplate);
  }

  @Test
  public void testReportHealth_RedisOk() {
    when(jobRepository.countByStatus("PENDING")).thenReturn(1L);
    when(jobRepository.countByStatus("PROCESSING")).thenReturn(2L);
    when(jobRepository.countByStatus("FAILED")).thenReturn(3L);
    when(redisTemplate.opsForValue()).thenReturn(valueOps);
    when(valueOps.get("health:ping")).thenReturn("pong");

    assertDoesNotThrow(() -> healthReporter.reportHealth());

    verify(valueOps).set("health:ping", "pong");
    verify(valueOps).get("health:ping");
  }

  @Test
  public void testReportHealth_RedisDown() {
    when(jobRepository.countByStatus(anyString())).thenReturn(0L);
    when(redisTemplate.opsForValue()).thenThrow(new RuntimeException("Redis down"));

    assertDoesNotThrow(() -> healthReporter.reportHealth());
  }
}
