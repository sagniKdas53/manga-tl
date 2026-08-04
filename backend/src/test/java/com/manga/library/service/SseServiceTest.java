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
  @Mock private org.springframework.scheduling.TaskScheduler taskScheduler;

  private final ObjectMapper objectMapper = new ObjectMapper();
  private SseService sseService;

  @BeforeEach
  public void setUp() {
    sseService = new SseService(redisTemplate, objectMapper, imageRepository, taskScheduler);
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

  /**
   * Stubs a pending queue and returns the scratch key the drain renamed it to (AUDIT-B4). Anything
   * still sitting on the live key after this has survived the drain.
   */
  private String stubPendingDrain(UUID userId, java.util.List<String> pending) {
    String key = "notifications:user:" + userId;
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(key)).thenReturn((long) pending.size());
    org.mockito.ArgumentCaptor<String> scratch = org.mockito.ArgumentCaptor.forClass(String.class);
    doAnswer(
            invocation -> {
              when(listOps.range(invocation.getArgument(1), 0, -1)).thenReturn(pending);
              return null;
            })
        .when(redisTemplate)
        .rename(eq(key), scratch.capture());
    return key;
  }

  @Test
  public void testSubscribe_WithPendingNotifications() {
    UUID userId = UUID.randomUUID();
    String key = stubPendingDrain(userId, java.util.List.of("{\"msg\":\"1\"}", "{\"msg\":\"2\"}"));

    SseEmitter emitter = sseService.subscribe(userId);

    assertNotNull(emitter);
    org.mockito.ArgumentCaptor<String> scratch = org.mockito.ArgumentCaptor.forClass(String.class);
    verify(redisTemplate).rename(eq(key), scratch.capture());
    verify(redisTemplate).delete(scratch.getValue());
  }

  @Test
  public void testSubscribe_DrainMovesTheQueueInsteadOfDeletingIt() {
    UUID userId = UUID.randomUUID();
    String key = stubPendingDrain(userId, java.util.List.of("{\"msg\":\"1\"}"));

    sseService.subscribe(userId);

    // The bug this replaces: range-then-delete were two calls, so a notification pushed in the
    // gap was deleted having never been sent. The live key is now never deleted at all -- a
    // concurrent push lands on a key this drain has no handle on.
    verify(redisTemplate, never()).delete(key);
    org.mockito.ArgumentCaptor<String> scratch = org.mockito.ArgumentCaptor.forClass(String.class);
    verify(redisTemplate).rename(eq(key), scratch.capture());
    assertTrue(
        scratch.getValue().startsWith(key + ":draining:"),
        "drained through a scratch key: " + scratch.getValue());
    verify(redisTemplate).delete(scratch.getValue());
  }

  @Test
  public void testSubscribe_NothingPendingSkipsTheRename() {
    UUID userId = UUID.randomUUID();
    expectNoPendingNotifications();

    sseService.subscribe(userId);

    // An empty queue is the overwhelmingly common case; it must not cost a RENAME that can only
    // fail, nor the exception that failure would raise.
    verify(redisTemplate, never()).rename(anyString(), anyString());
  }

  @Test
  public void testSubscribe_QueueDrainedByAnotherTabIsNotAnError() {
    UUID userId = UUID.randomUUID();
    String key = "notifications:user:" + userId;
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(key)).thenReturn(1L);
    // A second tab won the race between the size check and the RENAME, so the source is gone.
    doThrow(new org.springframework.data.redis.RedisSystemException("no such key", new RuntimeException()))
        .when(redisTemplate)
        .rename(eq(key), anyString());

    SseEmitter emitter = sseService.subscribe(userId);

    assertNotNull(emitter);
    verify(listOps, never()).range(anyString(), anyLong(), anyLong());
  }

  @Test
  public void testSubscribe_FailedSendRequeuesOnlyWhatWasMissed() throws Exception {
    UUID userId = UUID.randomUUID();
    String key =
        stubPendingDrain(
            userId, java.util.List.of("{\"msg\":\"1\"}", "{\"msg\":\"2\"}", "{\"msg\":\"3\"}"));

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) ->
                doNothing() // the "connected" event
                    .doNothing() // msg 1
                    .doThrow(new java.io.IOException("Pending send failed"))
                    .when(mock)
                    .send(any(SseEmitter.SseEventBuilder.class)))) {
      sseService.subscribe(userId);
    }

    @SuppressWarnings("unchecked")
    org.mockito.ArgumentCaptor<java.util.Collection<String>> requeued =
        org.mockito.ArgumentCaptor.forClass(java.util.Collection.class);
    verify(listOps).leftPushAll(eq(key), requeued.capture());

    // Msg 1 was delivered and must not come back -- the old code kept the whole batch on a failed
    // send and showed the delivered ones again. LPUSH prepends one at a time, so the tail goes in
    // backwards to come out in order.
    assertEquals(
        java.util.List.of("{\"msg\":\"3\"}", "{\"msg\":\"2\"}"),
        new java.util.ArrayList<>(requeued.getValue()));
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
    String key = stubPendingDrain(userId, java.util.List.of("{\"msg\":\"1\"}"));

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
      // Undelivered, so it goes back rather than being dropped.
      verify(listOps).leftPushAll(eq(key), anyCollection());
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

  /** Everything an emitter was asked to send, flattened, so an event name can be asserted on. */
  private static String sentBy(SseEmitter emitter) throws Exception {
    org.mockito.ArgumentCaptor<SseEmitter.SseEventBuilder> captor =
        org.mockito.ArgumentCaptor.forClass(SseEmitter.SseEventBuilder.class);
    verify(emitter, atLeastOnce()).send(captor.capture());
    StringBuilder sent = new StringBuilder();
    for (SseEmitter.SseEventBuilder builder : captor.getAllValues()) {
      builder.build().forEach(part -> sent.append(part.getData()));
    }
    return sent.toString();
  }

  private void expectNoPendingNotifications() {
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(0L);
  }

  @Test
  public void testSubscribe_ArmsTheSessionExpiredPushAtTheSessionsExpiry() {
    UUID userId = UUID.randomUUID();
    expectNoPendingNotifications();
    java.time.Instant expiry = java.time.Instant.now().plusSeconds(3600);

    sseService.subscribe(userId, expiry);

    // Against the token's own exp, not a poll and not a fixed delay -- a renewed session opens a
    // new connection, which arms a new one.
    verify(taskScheduler, times(1)).schedule(any(Runnable.class), eq(expiry));
  }

  @Test
  public void testSubscribe_WithoutAnExpiryArmsNothing() {
    UUID userId = UUID.randomUUID();
    expectNoPendingNotifications();

    sseService.subscribe(userId, null);

    // A ticket minted before this feature shipped carries no expiry; it must still connect.
    verifyNoInteractions(taskScheduler);
  }

  @Test
  public void testSubscribe_ArmedPushTellsTheConnectionThenClosesIt() throws Exception {
    UUID userId = UUID.randomUUID();
    expectNoPendingNotifications();

    org.mockito.ArgumentCaptor<Runnable> armed =
        org.mockito.ArgumentCaptor.forClass(Runnable.class);
    when(taskScheduler.schedule(any(Runnable.class), any(java.time.Instant.class)))
        .thenReturn(mock(java.util.concurrent.ScheduledFuture.class));

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> doNothing().when(mock).send(any(SseEmitter.SseEventBuilder.class)))) {
      sseService.subscribe(userId, java.time.Instant.now().plusSeconds(60));
      verify(taskScheduler).schedule(armed.capture(), any(java.time.Instant.class));

      SseEmitter emitter = mocked.constructed().get(0);
      armed.getValue().run();

      // The name is the contract: useSSE listens for exactly this and clears the stored session.
      assertTrue(sentBy(emitter).contains("session-expired"), "expected a session-expired event");
      // Closed too -- the client drops its token on this event, so a stream left open would only
      // invite a reconnect carrying a JWT that can no longer buy a ticket.
      verify(emitter, times(1)).complete();
      assertEquals(0, sseService.connectionCount(userId));
    }
  }

  @Test
  public void testSubscribe_DisconnectCancelsTheArmedPush() {
    UUID userId = UUID.randomUUID();
    expectNoPendingNotifications();

    java.util.concurrent.ScheduledFuture<?> future = mock(java.util.concurrent.ScheduledFuture.class);
    org.mockito.Mockito.<java.util.concurrent.ScheduledFuture<?>>when(
            taskScheduler.schedule(any(Runnable.class), any(java.time.Instant.class)))
        .thenReturn(future);

    org.mockito.ArgumentCaptor<Runnable> onCompletion =
        org.mockito.ArgumentCaptor.forClass(Runnable.class);

    try (org.mockito.MockedConstruction<SseEmitter> mocked =
        mockConstruction(
            SseEmitter.class,
            (mock, context) -> doNothing().when(mock).send(any(SseEmitter.SseEventBuilder.class)))) {
      sseService.subscribe(userId, java.time.Instant.now().plusSeconds(60));
      SseEmitter emitter = mocked.constructed().get(0);
      verify(emitter).onCompletion(onCompletion.capture());

      onCompletion.getValue().run();

      // A tab closed at noon must not leave a task holding its emitter until the token expires.
      // With a 24-hour token and a session's worth of reconnects those would outnumber the live
      // connections.
      verify(future, times(1)).cancel(false);
      assertEquals(0, sseService.connectionCount(userId));
    }
  }
}
