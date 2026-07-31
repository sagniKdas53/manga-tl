package com.manga.library;

import java.util.Objects;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.testcontainers.containers.GenericContainer;

@TestConfiguration
public class RedisTestcontainersConfig {

  @SuppressWarnings("resource")
  static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine")
      .withExposedPorts(6379);

  static {
    REDIS.start();
  }

  @Bean
  public RedisConnectionFactory redisConnectionFactory() {
    return new LettuceConnectionFactory(Objects.requireNonNull(REDIS.getHost()), REDIS.getMappedPort(6379));
  }

  @Bean(name = "taskScheduler")
  public org.springframework.scheduling.TaskScheduler noOpTaskScheduler() {
    return org.mockito.Mockito.mock(org.springframework.scheduling.TaskScheduler.class);
  }
}
