package com.manga.library;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.testcontainers.containers.GenericContainer;

@TestConfiguration
public class RedisTestcontainersConfig {

  static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine")
      .withExposedPorts(6379);

  static {
    REDIS.start();
  }

  @Bean
  @SuppressWarnings("resource")
  public RedisConnectionFactory redisConnectionFactory() {
    return new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
  }
}
