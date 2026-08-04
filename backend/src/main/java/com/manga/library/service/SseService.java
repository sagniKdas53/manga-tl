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

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;
  private final ImageRepository imageRepository;

  public SseService(
      StringRedisTemplate redisTemplate,
      ObjectMapper objectMapper,
      ImageRepository imageRepository) {
    this.redisTemplate = redisTemplate;
    this.objectMapper = objectMapper;
    this.imageRepository = imageRepository;
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

  public SseEmitter subscribe(UUID userId) {
    SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT);
    emitters.computeIfAbsent(userId, k -> new CopyOnWriteArrayList<>()).add(emitter);

    emitter.onCompletion(() -> removeEmitter(userId, emitter));
    emitter.onTimeout(
        () -> {
          emitter.complete();
          removeEmitter(userId, emitter);
        });
    emitter.onError(
        (e) -> {
          emitter.completeWithError(Objects.requireNonNull(e));
          removeEmitter(userId, emitter);
        });

    try {
      emitter.send(SseEmitter.event().name("connected").data("SSE Connection Established"));
    } catch (IOException e) {
      log.error("Error sending initial SSE event for user {}", userId, e);
      emitter.completeWithError(e);
    }

    sendPendingNotifications(userId, emitter);

    return emitter;
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

  private void sendPendingNotifications(UUID userId, SseEmitter emitter) {
    String key = NOTIFICATION_PREFIX + userId;
    Long size = redisTemplate.opsForList().size(key);
    if (size != null && size > 0) {
      List<String> pending = redisTemplate.opsForList().range(key, 0, -1);
      if (pending != null) {
        for (String notifJson : pending) {
          try {
            emitter.send(
                SseEmitter.event().name("notification").data(Objects.requireNonNull(notifJson)));
          } catch (IOException e) {
            log.error("Failed to send pending notification to user {}", userId, e);
            return; // If it fails, keep remaining in Redis
          }
        }
      }
      redisTemplate.delete(Objects.requireNonNull(key));
    }
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
    redisTemplate.expire(
        Objects.requireNonNull(key), Objects.requireNonNull(java.time.Duration.ofDays(7)));
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
