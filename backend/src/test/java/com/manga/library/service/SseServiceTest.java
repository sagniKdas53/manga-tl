package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.model.Image;
import com.manga.library.model.User;
import com.manga.library.repository.ImageRepository;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.redis.core.ListOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@ExtendWith(MockitoExtension.class)
@SuppressWarnings({"null", "unused"})
public class SseServiceTest {

  @Mock private StringRedisTemplate redisTemplate;
  @Mock private ListOperations<String, String> listOps;
  @Mock private ValueOperations<String, String> valOps;
  @Mock private ImageRepository imageRepository;

  private final ObjectMapper objectMapper = new ObjectMapper();
  private SseService sseService;

  @BeforeEach
  public void setUp() {
    sseService = new SseService(redisTemplate, objectMapper, imageRepository);
  }

  @Test
  public void testSubscribe() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    SseEmitter emitter = sseService.subscribe(userId);
    assertNotNull(emitter);
  }

  @Test
  public void testMapImageToUser() {
    UUID imageId = UUID.randomUUID();
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForValue()).thenReturn(valOps);

    sseService.mapImageToUser(imageId, userId);

    verify(valOps, times(1)).set(eq("job:owner:image:" + imageId), eq(userId.toString()), any());
  }

  @Test
  public void testEmitNotificationForImage_NoUserFound() {
    UUID imageId = UUID.randomUUID();
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("job:owner:image:" + imageId)).thenReturn(null);

    sseService.emitNotificationForImage(imageId, "type", "title", "msg");

    verify(redisTemplate, never()).opsForList();
  }

  @Test
  public void testEmitNotificationForImage_UserFound() {
    UUID imageId = UUID.randomUUID();
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("job:owner:image:" + imageId)).thenReturn(userId.toString());
    when(redisTemplate.opsForList()).thenReturn(listOps);

    sseService.emitNotificationForImage(imageId, "type", "title", "msg");

    verify(listOps, times(1)).rightPush(eq("notifications:user:" + userId), anyString());
  }

  @Test
  public void testEmitNotification() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);

    sseService.emitNotificationToUser(userId, "type", "title", "msg", UUID.randomUUID());

    verify(listOps, times(1)).rightPush(eq("notifications:user:" + userId), anyString());
  }

  @Test
  public void testSubscribe_WithPendingNotifications() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size("notifications:user:" + userId)).thenReturn(2L);
    when(listOps.range("notifications:user:" + userId, 0, -1))
        .thenReturn(java.util.Arrays.asList("{\"msg\":\"1\"}", "{\"msg\":\"2\"}"));

    SseEmitter emitter = sseService.subscribe(userId);
    assertNotNull(emitter);
    verify(redisTemplate).delete("notifications:user:" + userId);
  }

  @Test
  public void testEmitNotificationForImage_FallbackToDb() {
    UUID imageId = UUID.randomUUID();
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("job:owner:image:" + imageId)).thenReturn(null);

    User creator =
        new User() {
          {
            setId(userId);
          }
        };
    Image image =
        new Image() {
          {
            setId(imageId);
            setCreatedBy(creator);
          }
        };
    when(imageRepository.findById(imageId)).thenReturn(java.util.Optional.of(image));
    when(redisTemplate.opsForList()).thenReturn(listOps);

    sseService.emitNotificationForImage(imageId, "type", "title", "msg");

    verify(listOps, times(1)).rightPush(eq("notifications:user:" + userId), anyString());
    verify(valOps, times(1)).set(eq("job:owner:image:" + imageId), eq(userId.toString()), any());
  }

  @Test
  public void testEmitNotificationForImage_FallbackToDbNoUser() {
    UUID imageId = UUID.randomUUID();
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("job:owner:image:" + imageId)).thenReturn(null);

    Image image =
        new Image() {
          {
            setId(imageId);
            setCreatedBy(null);
          }
        };
    when(imageRepository.findById(imageId)).thenReturn(java.util.Optional.of(image));

    sseService.emitNotificationForImage(imageId, "type", "title", "msg");

    verify(redisTemplate, never()).opsForList();
  }

  @Test
  public void testEmitNotificationForImage_FallbackToDbNotFound() {
    UUID imageId = UUID.randomUUID();
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("job:owner:image:" + imageId)).thenReturn(null);
    when(imageRepository.findById(imageId)).thenReturn(java.util.Optional.empty());

    sseService.emitNotificationForImage(imageId, "type", "title", "msg");

    verify(redisTemplate, never()).opsForList();
  }

  @Test
  public void testEmitLiveNotificationToUser() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    // Subscribe to register the live emitter
    SseEmitter emitter = sseService.subscribe(userId);
    assertNotNull(emitter);

    // Emit live notification
    sseService.emitNotificationToUser(userId, "type", "title", "msg");
    // Should NOT push to redis operations list because it's delivered live (or falls back to push
    // on emitter.send throw)
    // Here SseEmitter has mock behavior / default send that might or might not fail, let's verify
    // Live delivery
  }

  @Test
  public void testSubscribe_SendInitialEventException() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              doThrow(new java.io.IOException("Connection reset"))
                  .when(mock)
                  .send(any(SseEmitter.SseEventBuilder.class));
            })) {
      SseEmitter emitter = sseService.subscribe(userId);
      assertNotNull(emitter);
    }
  }

  @Test
  public void testSubscribe_SendPendingNotificationException() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size("notifications:user:" + userId)).thenReturn(1L);
    when(listOps.range("notifications:user:" + userId, 0, -1))
        .thenReturn(java.util.Collections.singletonList("{\"msg\":\"1\"}"));

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              doNothing()
                  .doThrow(new java.io.IOException("Pending send failed"))
                  .when(mock)
                  .send(any(SseEmitter.SseEventBuilder.class));
            })) {
      SseEmitter emitter = sseService.subscribe(userId);
      assertNotNull(emitter);
      verify(redisTemplate, never()).delete("notifications:user:" + userId);
    }
  }

  @Test
  public void testEmitLiveNotificationToUser_SendException() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              doNothing()
                  .doThrow(new java.io.IOException("Live send failed"))
                  .when(mock)
                  .send(any(SseEmitter.SseEventBuilder.class));
            })) {
      SseEmitter emitter = sseService.subscribe(userId);
      assertNotNull(emitter);

      sseService.emitNotificationToUser(userId, "type", "title", "msg");

      verify(listOps, times(1)).rightPush(eq("notifications:user:" + userId), anyString());
    }
  }

  @Test
  public void testSubscribe_Callbacks() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    final java.util.List<Runnable> completionCallbacks = new java.util.ArrayList<>();
    final java.util.List<Runnable> timeoutCallbacks = new java.util.ArrayList<>();
    final java.util.List<java.util.function.Consumer<Throwable>> errorCallbacks =
        new java.util.ArrayList<>();

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              doAnswer(
                      invocation -> {
                        completionCallbacks.add(invocation.getArgument(0));
                        return null;
                      })
                  .when(mock)
                  .onCompletion(any());
              doAnswer(
                      invocation -> {
                        timeoutCallbacks.add(invocation.getArgument(0));
                        return null;
                      })
                  .when(mock)
                  .onTimeout(any());
              doAnswer(
                      invocation -> {
                        errorCallbacks.add(invocation.getArgument(0));
                        return null;
                      })
                  .when(mock)
                  .onError(any());
            })) {
      SseEmitter emitter = sseService.subscribe(userId);
      assertNotNull(emitter);

      assertFalse(completionCallbacks.isEmpty());
      completionCallbacks.get(0).run();

      assertFalse(timeoutCallbacks.isEmpty());
      timeoutCallbacks.get(0).run();

      assertFalse(errorCallbacks.isEmpty());
      errorCallbacks.get(0).accept(new RuntimeException("test error"));
    }
  }

  @Test
  public void testEmitEventToAllUsers() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              doNothing().when(mock).send(any(SseEmitter.SseEventBuilder.class));
            })) {
      sseService.subscribe(userId);
      sseService.emitEventToAllUsers("test_event", "test_data");
      // Verify send was called on the emitter
      assertFalse(mocked.constructed().isEmpty());
      verify(mocked.constructed().get(0), times(2)).send(any(SseEmitter.SseEventBuilder.class));
    } catch (Exception e) {
      fail("Exception not expected");
    }
  }

  /**
   * AUDIT-B4. Emitters were held one-per-user in a map written with a plain {@code put}, so opening
   * a second tab evicted the first tab's emitter and that tab stopped receiving {@code job_update}
   * events entirely — it looked frozen until reload. Both tabs must now be served.
   */
  @Test
  public void testSecondTabDoesNotEvictTheFirst() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> doNothing().when(mock).send(any(SseEmitter.SseEventBuilder.class)))) {
      sseService.subscribe(userId);
      sseService.subscribe(userId);

      assertEquals(2, mocked.constructed().size(), "expected two distinct emitters");
      assertEquals(2, sseService.connectionCount(userId));

      sseService.emitEventToUser(userId, "job_update", "payload");

      // One "connected" event each at subscribe, then the job_update both must receive.
      verify(mocked.constructed().get(0), times(2)).send(any(SseEmitter.SseEventBuilder.class));
      verify(mocked.constructed().get(1), times(2)).send(any(SseEmitter.SseEventBuilder.class));
    } catch (Exception e) {
      fail("Exception not expected: " + e);
    }
  }

  /** Closing one tab must not take the other tab's stream down with it. */
  @Test
  public void testClosingOneTabLeavesTheOtherConnected() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    final java.util.List<Runnable> completionCallbacks = new java.util.ArrayList<>();

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              doNothing().when(mock).send(any(SseEmitter.SseEventBuilder.class));
              doAnswer(
                      invocation -> {
                        completionCallbacks.add(invocation.getArgument(0));
                        return null;
                      })
                  .when(mock)
                  .onCompletion(any());
            })) {
      sseService.subscribe(userId);
      sseService.subscribe(userId);
      assertEquals(2, sseService.connectionCount(userId));

      // First tab closes.
      completionCallbacks.get(0).run();
      assertEquals(1, sseService.connectionCount(userId), "second tab should still be registered");

      sseService.emitEventToUser(userId, "job_update", "payload");

      verify(mocked.constructed().get(0), times(1)).send(any(SseEmitter.SseEventBuilder.class));
      verify(mocked.constructed().get(1), times(2)).send(any(SseEmitter.SseEventBuilder.class));

      // Last tab closes — the user's entry goes, rather than leaking an empty collection.
      completionCallbacks.get(1).run();
      assertEquals(0, sseService.connectionCount(userId));
    } catch (Exception e) {
      fail("Exception not expected: " + e);
    }
  }

  /**
   * A notification is queued to Redis only when no tab took it. With one live tab and one dead one,
   * the user has still seen it — queueing as well would replay it on the next subscribe.
   */
  @Test
  public void testNotificationIsNotQueuedWhenOneOfTwoTabsAcceptsIt() {
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              if (context.getCount() == 1) {
                // First tab is dead: accepts the "connected" event, then fails.
                doNothing()
                    .doThrow(new java.io.IOException("broken pipe"))
                    .when(mock)
                    .send(any(SseEmitter.SseEventBuilder.class));
              } else {
                doNothing().when(mock).send(any(SseEmitter.SseEventBuilder.class));
              }
            })) {
      sseService.subscribe(userId);
      sseService.subscribe(userId);

      sseService.emitNotificationToUser(userId, "type", "title", "msg");

      verify(listOps, never()).rightPush(eq("notifications:user:" + userId), anyString());
      // The failed emitter is dropped; the healthy one stays.
      assertEquals(1, sseService.connectionCount(userId));
    } catch (Exception e) {
      fail("Exception not expected: " + e);
    }
  }

  @Test
  public void testEmitEventForImage() {
    UUID imageId = UUID.randomUUID();
    UUID userId = UUID.randomUUID();
    when(redisTemplate.opsForValue()).thenReturn(valOps);
    when(valOps.get("job:owner:image:" + imageId)).thenReturn(userId.toString());
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> {
              doNothing().when(mock).send(any(SseEmitter.SseEventBuilder.class));
            })) {
      sseService.subscribe(userId);
      sseService.emitEventForImage(imageId, "job_update", "test_data");
      assertFalse(mocked.constructed().isEmpty());
      verify(mocked.constructed().get(0), times(2)).send(any(SseEmitter.SseEventBuilder.class));
    } catch (Exception e) {
      fail("Exception not expected");
    }
  }
}
