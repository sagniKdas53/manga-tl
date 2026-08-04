package com.manga.library.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import com.manga.library.RedisTestcontainersConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.annotation.Transactional;

/**
 * AUDIT-B2. {@code onStartup} called {@code this.resetProcessingJobsToPending()}. Self-invocation
 * does not cross the Spring proxy, so the {@code @Transactional} on the target method never applied
 * and the batch of PROCESSING→PENDING writes ran unwrapped — a mid-loop failure left the job table
 * half-migrated.
 *
 * <p>Nothing at the call site shows this. The annotation is present, the method is public, the code
 * reads correctly, and it silently does nothing. That is the whole reason this needs a test.
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(RedisTestcontainersConfig.class)
@SuppressWarnings("null")
public class JobCoordinatorStartupTransactionTest {

  @Autowired private JobCoordinatorService jobCoordinatorService;

  private Object originalSelf;

  @AfterEach
  public void restoreSelf() {
    if (originalSelf != null) {
      ReflectionTestUtils.setField(jobCoordinatorService, "self", originalSelf);
      originalSelf = null;
    }
  }

  @Test
  public void selfIsInjectedAsAProxy_notTheRawInstance() {
    Object self = ReflectionTestUtils.getField(jobCoordinatorService, "self");

    assertThat(self).as("the self-reference must be wired").isNotNull();
    assertThat(AopUtils.isAopProxy(self))
        .as("self must be the proxied bean, or @Transactional still will not apply")
        .isTrue();
  }

  @Test
  public void onStartup_reachesResetThroughTheProxyRatherThanThis() {
    JobCoordinatorService proxyStandIn = mock(JobCoordinatorService.class);
    originalSelf = ReflectionTestUtils.getField(jobCoordinatorService, "self");
    ReflectionTestUtils.setField(jobCoordinatorService, "self", proxyStandIn);

    jobCoordinatorService.onStartup();

    // The call has to leave the object. Under the old `this.resetProcessingJobsToPending()` the
    // stand-in never sees it, because the call never crosses a proxy boundary at all.
    verify(proxyStandIn).resetProcessingJobsToPending();
  }

  @Test
  public void resetPropagatesFailuresSoTheTransactionCanRollBack() {
    // The method used to swallow every exception internally. A transaction that never sees the
    // failure commits whatever the loop managed first — exactly the half-migrated table the
    // @Transactional was meant to prevent. Routing through the proxy alone does not fix that.
    JobCoordinatorService throwing = mock(JobCoordinatorService.class);
    doThrow(new IllegalStateException("db went away"))
        .when(throwing)
        .resetProcessingJobsToPending();

    assertThatThrownBy(throwing::resetProcessingJobsToPending)
        .isInstanceOf(IllegalStateException.class);

    // ...while startup itself still tolerates the failure and brings the app up.
    originalSelf = ReflectionTestUtils.getField(jobCoordinatorService, "self");
    ReflectionTestUtils.setField(jobCoordinatorService, "self", throwing);

    assertThatCode(jobCoordinatorService::onStartup).doesNotThrowAnyException();
  }

  @Test
  public void resetIsAnnotatedTransactional() throws NoSuchMethodException {
    // Pins the annotation itself: without it the proxy routing above buys nothing.
    assertThat(
            JobCoordinatorService.class
                .getMethod("resetProcessingJobsToPending")
                .isAnnotationPresent(Transactional.class))
        .isTrue();
  }
}
