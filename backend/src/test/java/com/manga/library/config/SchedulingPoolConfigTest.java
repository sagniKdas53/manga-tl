package com.manga.library.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.yaml.snakeyaml.Yaml;

/**
 * AUDIT-B1. Five {@code @Scheduled} tasks share one pool: {@code
 * WorkerDispatcherService.dispatchJobs} (every 2s, blocking up to 30s per worker), {@code
 * JobCoordinatorService.recoverStaleProcessingJobs} (5 min), {@code DebouncedRenderService} (5s),
 * {@code HealthReporter} (5 min) and {@code ExportCleanupService} (daily). Spring's default pool
 * size is 1, so one unresponsive worker serialises everything else behind a 30s HTTP timeout.
 *
 * <p>Two things have to hold, and only the pair is worth anything: the value in {@code
 * application.yml} has to be greater than 1, <em>and</em> the key it is written under has to be the
 * one Spring actually binds. A typo in the YAML path is silent — the app starts, the pool stays at
 * 1, and nothing anywhere reports it.
 */
public class SchedulingPoolConfigTest {

  /** Minimum that keeps the blocking dispatcher from starving the other four tasks. */
  private static final int MIN_POOL_SIZE = 4;

  private static final String YAML_DEFAULT_POOL_SIZE = "${SCHEDULING_POOL_SIZE:4}";

  @SuppressWarnings("unchecked")
  private static Map<String, Object> child(Map<String, Object> parent, String key) {
    Object value = parent == null ? null : parent.get(key);
    assertThat(value)
        .as("application.yml is missing the '%s' block under spring.task.scheduling", key)
        .isInstanceOf(Map.class);
    return (Map<String, Object>) value;
  }

  @Test
  void applicationYaml_declaresASchedulingPoolLargerThanTheSpringDefault() throws Exception {
    Map<String, Object> root;
    try (InputStream in =
        getClass().getClassLoader().getResourceAsStream("application.yml")) {
      assertThat(in).as("application.yml is not on the test classpath").isNotNull();
      root = new Yaml().load(in);
    }

    Map<String, Object> spring = child(root, "spring");
    Map<String, Object> pool = child(child(child(spring, "task"), "scheduling"), "pool");

    assertThat(pool.get("size"))
        .as("spring.task.scheduling.pool.size must stay overridable with a sane default")
        .isEqualTo(YAML_DEFAULT_POOL_SIZE);
  }

  /**
   * The auto-configured {@code taskScheduler} is {@code @ConditionalOnBean} the scheduled-annotation
   * processor, which is what {@code @EnableScheduling} registers. {@code MangaLibraryApplication}
   * carries that annotation in production.
   */
  @Configuration(proxyBeanMethods = false)
  @EnableScheduling
  static class SchedulingEnabled {}

  private ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withUserConfiguration(SchedulingEnabled.class)
        .withConfiguration(AutoConfigurations.of(TaskSchedulingAutoConfiguration.class));
  }

  @Test
  void poolSizeProperty_isBoundByTaskSchedulingAutoConfiguration() {
    runner()
        .withPropertyValues("spring.task.scheduling.pool.size=" + MIN_POOL_SIZE)
        .run(
            context -> {
              assertThat(context).hasNotFailed();
              ThreadPoolTaskScheduler scheduler = context.getBean(ThreadPoolTaskScheduler.class);
              assertThat(scheduler.getScheduledThreadPoolExecutor().getCorePoolSize())
                  .isEqualTo(MIN_POOL_SIZE);
            });
  }

  @Test
  void withoutTheProperty_springFallsBackToASinglethreadedPool() {
    // Pins the reason the property exists at all: this is what production ran before AUDIT-B1.
    runner()
        .run(
            context -> {
              assertThat(context).hasNotFailed();
              assertThat(
                      context
                          .getBean(ThreadPoolTaskScheduler.class)
                          .getScheduledThreadPoolExecutor()
                          .getCorePoolSize())
                  .isEqualTo(1);
            });
  }
}
