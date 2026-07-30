package com.manga.library;

import java.util.Objects;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;

@TestConfiguration
public class TestcontainersConfig {

  static {
    System.setProperty("api.version", "1.44");
  }

  @SuppressWarnings("resource")
  static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine")
      .withExposedPorts(6379);

  static {
    REDIS.start();
  }

  @Bean
  @ServiceConnection
  @SuppressWarnings("resource")
  public PostgreSQLContainer<?> postgresContainer() {
    return new PostgreSQLContainer<>("postgres:15-alpine")
        .withDatabaseName("testdb")
        .withUsername("tladmin")
        .withPassword("test")
        .withInitScript("init-test.sql");
  }

  @Bean
  public RedisConnectionFactory redisConnectionFactory() {
    return new LettuceConnectionFactory(Objects.requireNonNull(REDIS.getHost()), REDIS.getMappedPort(6379));
  }
}
