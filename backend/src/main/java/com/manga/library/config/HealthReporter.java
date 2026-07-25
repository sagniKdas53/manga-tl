package com.manga.library.config;

import com.manga.library.repository.JobRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

@Configuration
@EnableScheduling
public class HealthReporter {
  private static final Logger log = LoggerFactory.getLogger(HealthReporter.class);

  @Autowired private JobRepository jobRepository;
  @Autowired private StringRedisTemplate redisTemplate;

  @Scheduled(fixedRate = 300000) // every 5 minutes
  public void reportHealth() {
    long pending = jobRepository.countByStatus("PENDING");
    long processing = jobRepository.countByStatus("PROCESSING");
    long failed = jobRepository.countByStatus("FAILED");
    try {
      redisTemplate.opsForValue().set("health:ping", "pong");
      String ping = redisTemplate.opsForValue().get("health:ping");
      log.info(
          "Health: queue[pending={}, processing={}, failed={}] redis={}",
          pending,
          processing,
          failed,
          "pong".equals(ping) ? "OK" : "DOWN");
    } catch (Exception e) {
      log.warn(
          "Health: queue[pending={}, processing={}, failed={}] redis=DOWN",
          pending,
          processing,
          failed);
    }
  }
}
