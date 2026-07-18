package com.manga.library;

import java.util.concurrent.Executor;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

@SpringBootApplication
@EnableScheduling
@EnableAsync
@SuppressWarnings("null")
public class MangaLibraryApplication {
  public static void main(String[] args) {
    SpringApplication.run(MangaLibraryApplication.class, args);
  }

  @Bean(name = "thumbnailExecutor")
  public Executor thumbnailExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(2);
    executor.setMaxPoolSize(4);
    executor.setQueueCapacity(500);
    executor.setThreadNamePrefix("Thumbnail-");
    executor.initialize();
    return executor;
  }
}
