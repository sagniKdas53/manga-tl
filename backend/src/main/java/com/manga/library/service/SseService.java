package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.repository.ImageRepository;
import java.io.IOException;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Service
public class SseService {
  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(SseService.class);

  /** The event name the browser listens for; it clears the stored session on receipt. */
  static final String SESSION_EXPIRED_EVENT = "session-expired";

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;
  private final ImageRepository imageRepository;
  private final org.springframework.scheduling.TaskScheduler taskScheduler;

  public SseService(
      StringRedisTemplate redisTemplate,
      ObjectMapper objectMapper,
      ImageRepository imageRepository,
      org.springframework.scheduling.TaskScheduler taskScheduler) {
    this.redisTemplate = redisTemplate;
    this.objectMapper = objectMapper;
    this.imageRepository = imageRepository;
    this.taskScheduler = taskScheduler;
  }

  /**
   * One user may have several live connections — a second browser tab, a phone alongside a laptop.
   * AUDIT-B4: this used to be a {@code Map<UUID, SseEmitter>} written with a plain {@code put}, so
   * opening a second tab silently evicted the first tab's emitter and that tab stopped receiving
   * {@code job_update} events, looking frozen until reload.
   */
  private final ConcurrentHashMap<UUID, Collection<SseEmitter>> emitters = new ConcurrentHashMap<>();

  private static final String NOTIFICATION_PREFIX = "notifications:user:";
  private static final String IMAGE_USER_MAPPING_PREFIX = "job:owner:image:";
  private static final long EMITTER_TIMEOUT = 3600000L; // 1 hour

  /** How long an undelivered notification waits for the user to open a connection. */
  private static final java.time.Duration PENDING_TTL = java.time.Duration.ofDays(7);

  /** Subscribes without arming the expiry push — the session's expiry is not known. */
  public SseEmitter subscribe(UUID userId) {
    return subscribe(userId, null);
  }

  /**
   * Opens a stream and, when {@code sessionExpiresAt} is known, arms a single push of {@link
   * #SESSION_EXPIRED_EVENT} for that moment (AUDIT-F7).
   *
   * <p>This does <em>not</em> replace the client's own expiry timer, and is not a security control
   * — nothing here decides whether a request is authorised. A frozen mobile tab has no live
   * connection to receive a push, which is the case that produced the original blank-screen report.
   * What it closes is the other one: an idle tab with an open connection learning at the moment it
   * happens instead of on its next request.
   *
   * <p>Per-connection timers are only reasonable because AUDIT-B1 gave the scheduler a pool of 4;
   * against Spring's default of 1 these would have queued behind {@code dispatchJobs}.
   */
  public SseEmitter subscribe(UUID userId, java.time.Instant sessionExpiresAt) {
    SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT);
    emitters.computeIfAbsent(userId, k -> new CopyOnWriteArrayList<>()).add(emitter);

    // Cancelled on every terminal path. A tab that closes at noon must not leave a task holding
    // its emitter until midnight -- with a 24-hour token and a browser session's worth of
    // reconnects, that leak would outnumber the live connections.
    java.util.concurrent.atomic.AtomicReference<java.util.concurrent.ScheduledFuture<?>>
        expiryPush = new java.util.concurrent.atomic.AtomicReference<>();

    emitter.onCompletion(
        () -> {
          cancel(expiryPush);
          removeEmitter(userId, emitter);
        });
    emitter.onTimeout(
        () -> {
          cancel(expiryPush);
          emitter.complete();
          removeEmitter(userId, emitter);
        });
    emitter.onError(
        (e) -> {
          cancel(expiryPush);
          emitter.completeWithError(Objects.requireNonNull(e));
          removeEmitter(userId, emitter);
        });

    if (sessionExpiresAt != null) {
      try {
        expiryPush.set(
            taskScheduler.schedule(() -> pushSessionExpired(userId, emitter), sessionExpiresAt));
      } catch (org.springframework.core.task.TaskRejectedException e) {
        // Worth a line, not a failed connection: the stream itself is fine without the push.
        log.warn("Could not arm the session-expired push for user {}: {}", userId, e.getMessage());
      }
    }

    try {
      emitter.send(SseEmitter.event().name("connected").data("SSE Connection Established"));
    } catch (IOException e) {
      log.error("Error sending initial SSE event for user {}", userId, e);
      emitter.completeWithError(e);
    }

    sendPendingNotifications(userId, emitter);

    return emitter;
  }

  private static void cancel(
      java.util.concurrent.atomic.AtomicReference<java.util.concurrent.ScheduledFuture<?>> ref) {
    java.util.concurrent.ScheduledFuture<?> scheduled = ref.getAndSet(null);
    if (scheduled != null) {
      scheduled.cancel(false);
    }
  }

  /**
   * Tells one connection its session has just expired, then closes it.
   *
   * <p>Closing is the point of the exercise: the client clears its stored token on this event, so
   * leaving the stream open would only invite a reconnect carrying a token that can no longer buy
   * a ticket.
   */
  private void pushSessionExpired(UUID userId, SseEmitter emitter) {
    try {
      emitter.send(
          SseEmitter.event().name(SESSION_EXPIRED_EVENT).data("{\"reason\":\"expired\"}"));
    } catch (IOException | IllegalStateException e) {
      // The tab was already gone. Nothing to tell, and nothing to fix.
      log.debug("Session-expired push found a dead connection for user {}", userId);
    } finally {
      emitter.complete();
      removeEmitter(userId, emitter);
    }
  }

  /**
   * Drops one emitter, and drops the user's entry entirely once its last connection goes. Done under
   * {@code compute} so a disconnect racing a subscribe cannot strand a live emitter in a collection
   * that has already been detached from the map.
   */
  private void removeEmitter(UUID userId, SseEmitter emitter) {
    emitters.computeIfPresent(
        userId,
        (k, connections) -> {
          connections.remove(emitter);
          return connections.isEmpty() ? null : connections;
        });
  }

  /**
   * Sends to every live connection this user has, dropping the ones that fail.
   *
   * @return true if at least one connection took the event — the caller uses this to decide whether
   *     the payload still needs queueing to Redis for later delivery.
   */
  private boolean sendToUser(UUID userId, String eventName, String jsonPayload) {
    Collection<SseEmitter> connections = emitters.get(userId);
    if (connections == null || connections.isEmpty()) {
      return false;
    }
    boolean delivered = false;
    for (SseEmitter emitter : connections) {
      try {
        emitter.send(
            SseEmitter.event()
                .name(Objects.requireNonNull(eventName))
                .data(Objects.requireNonNull(jsonPayload)));
        delivered = true;
      } catch (IOException | IllegalStateException e) {
        log.warn(
            "Failed to send live '{}' to a connection of user {}, removing that emitter: {}",
            eventName,
            userId,
            e.getMessage());
        removeEmitter(userId, emitter);
      }
    }
    return delivered;
  }

  /**
   * Delivers everything queued for a user while they had no open connection.
   *
   * <p>AUDIT-B4's other half. This used to {@code range} the list and then {@code delete} it as two
   * separate calls, so a notification pushed in the gap between them was deleted having never been
   * sent, and nothing recorded that it had happened. {@code RENAME} moves the whole list in one
   * operation instead: anything queued a microsecond later lands on a fresh {@code key} that this
   * drain has no handle on.
   */
  private void sendPendingNotifications(UUID userId, SseEmitter emitter) {
    String key = NOTIFICATION_PREFIX + userId;
    Long size = redisTemplate.opsForList().size(key);
    if (size == null || size == 0) {
      return; // The overwhelmingly common case; not worth a RENAME that would only fail.
    }

    String draining = key + ":draining:" + UUID.randomUUID();
    try {
      redisTemplate.rename(key, draining);
    } catch (org.springframework.dao.DataAccessException e) {
      // RENAME errors when the source is gone: a second tab drained it, or it expired, between
      // the size check and here. Either way there is nothing left to deliver.
      return;
    }

    List<String> pending = redisTemplate.opsForList().range(draining, 0, -1);
    redisTemplate.delete(Objects.requireNonNull(draining));
    if (pending == null) {
      return;
    }

    for (int i = 0; i < pending.size(); i++) {
      try {
        emitter.send(
            SseEmitter.event().name("notification").data(Objects.requireNonNull(pending.get(i))));
      } catch (IOException e) {
        log.error("Failed to send pending notification to user {}", userId, e);
        requeue(key, pending.subList(i, pending.size()));
        return;
      }
    }
  }

  /**
   * Puts an undelivered tail back at the head of the queue, so the next connection gets it.
   *
   * <p>The old code kept the whole batch on a failed send, including the ones already delivered,
   * which showed those again on the next subscribe. Only what was actually missed goes back.
   */
  private void requeue(String key, List<String> unsent) {
    // LPUSH prepends argument by argument, so the list has to go in backwards to come out in order.
    List<String> reversed = new java.util.ArrayList<>(unsent);
    java.util.Collections.reverse(reversed);
    redisTemplate.opsForList().leftPushAll(Objects.requireNonNull(key), reversed);
    redisTemplate.expire(Objects.requireNonNull(key), PENDING_TTL);
  }

  public void mapImageToUser(UUID imageId, UUID userId) {
    redisTemplate
        .opsForValue()
        .set(
            Objects.requireNonNull(IMAGE_USER_MAPPING_PREFIX + imageId),
            Objects.requireNonNull(userId.toString()),
            Objects.requireNonNull(java.time.Duration.ofHours(24)));
  }

  public void emitNotificationForImage(UUID imageId, String type, String title, String message) {
    emitNotificationForImage(imageId, type, title, message, null);
  }

  public void emitNotificationForImage(
      UUID imageId, String type, String title, String message, Map<String, String> context) {
    String userIdStr = redisTemplate.opsForValue().get(IMAGE_USER_MAPPING_PREFIX + imageId);
    if (userIdStr != null) {
      emitNotificationToUser(UUID.fromString(userIdStr), type, title, message, imageId, context);
    } else {
      imageRepository
          .findById(Objects.requireNonNull(imageId))
          .ifPresentOrElse(
              image -> {
                if (image.getCreatedBy() != null) {
                  UUID uId = image.getCreatedBy().getId();
                  emitNotificationToUser(uId, type, title, message, imageId, context);
                  mapImageToUser(imageId, uId);
                }
              },
              () ->
                  log.warn(
                      "Could not find owner user for image {} in Redis or DB. Cannot send SSE notification.",
                      imageId));
    }
  }

  public void emitNotificationToUser(UUID userId, String type, String title, String message) {
    emitNotificationToUser(userId, type, title, message, null, null);
  }

  public void emitNotificationToUser(
      UUID userId, String type, String title, String message, UUID imageId) {
    emitNotificationToUser(userId, type, title, message, imageId, null);
  }

  public void emitNotificationToUser(
      UUID userId,
      String type,
      String title,
      String message,
      UUID imageId,
      Map<String, String> context) {
    Map<String, Object> notification = new java.util.HashMap<>();
    notification.put("id", UUID.randomUUID().toString());
    notification.put("type", type);
    notification.put("title", title);
    notification.put("message", message);
    notification.put("timestamp", System.currentTimeMillis());
    if (imageId != null) {
      notification.put("imageId", imageId.toString());
    }
    if (context != null) {
      notification.put("context", context);
    }

    String jsonPayload;
    try {
      jsonPayload = objectMapper.writeValueAsString(notification);
    } catch (Exception e) {
      log.error("Failed to serialize notification", e);
      return;
    }

    // Only queue for later if no open tab took it. If any connection accepted the notification the
    // user has seen it, and pushing to Redis as well would show it again on the next subscribe.
    if (sendToUser(userId, "notification", jsonPayload)) {
      return;
    }

    String key = NOTIFICATION_PREFIX + userId;
    redisTemplate
        .opsForList()
        .rightPush(Objects.requireNonNull(key), Objects.requireNonNull(jsonPayload));
    redisTemplate.expire(Objects.requireNonNull(key), PENDING_TTL);
  }

  public void emitEventToAllUsers(String eventName, Object data) {
    String jsonPayload;
    try {
      jsonPayload = objectMapper.writeValueAsString(data);
    } catch (Exception e) {
      log.error("Failed to serialize event data", e);
      return;
    }

    for (UUID uId : emitters.keySet()) {
      sendToUser(uId, eventName, jsonPayload);
    }
  }

  public void emitEventForImage(UUID imageId, String eventName, Object data) {
    String userIdStr = redisTemplate.opsForValue().get(IMAGE_USER_MAPPING_PREFIX + imageId);
    if (userIdStr != null) {
      emitEventToUser(UUID.fromString(userIdStr), eventName, data);
    } else {
      imageRepository
          .findById(Objects.requireNonNull(imageId))
          .ifPresentOrElse(
              image -> {
                if (image.getCreatedBy() != null) {
                  UUID uId = image.getCreatedBy().getId();
                  emitEventToUser(uId, eventName, data);
                  mapImageToUser(imageId, uId);
                }
              },
              () ->
                  log.warn(
                      "Could not find owner user for image {} in Redis or DB. Cannot send SSE event.",
                      imageId));
    }
  }

  public void emitEventToUser(UUID userId, String eventName, Object data) {
    String jsonPayload;
    try {
      jsonPayload = objectMapper.writeValueAsString(data);
    } catch (Exception e) {
      log.error("Failed to serialize event data", e);
      return;
    }

    sendToUser(userId, eventName, jsonPayload);
  }

  /** Visible for testing: how many live connections a user currently holds. */
  int connectionCount(UUID userId) {
    Collection<SseEmitter> connections = emitters.get(userId);
    return connections == null ? 0 : connections.size();
  }
}
