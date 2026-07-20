package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.repository.ImageRepository;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Service
@RequiredArgsConstructor
@Slf4j
public class SseService {

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;
  private final ImageRepository imageRepository;
  private final ConcurrentHashMap<UUID, SseEmitter> emitters = new ConcurrentHashMap<>();

  private static final String NOTIFICATION_PREFIX = "notifications:user:";
  private static final String IMAGE_USER_MAPPING_PREFIX = "job:owner:image:";
  private static final long EMITTER_TIMEOUT = 3600000L; // 1 hour

  public SseEmitter subscribe(UUID userId) {
    SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT);
    emitters.put(userId, emitter);

    emitter.onCompletion(() -> emitters.remove(userId));
    emitter.onTimeout(
        () -> {
          emitter.complete();
          emitters.remove(userId);
        });
    emitter.onError(
        (e) -> {
          emitter.completeWithError(Objects.requireNonNull(e));
          emitters.remove(userId);
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

    SseEmitter emitter = emitters.get(userId);
    if (emitter != null) {
      try {
        emitter.send(
            SseEmitter.event().name("notification").data(Objects.requireNonNull(jsonPayload)));
        return;
      } catch (IOException e) {
        log.error("Failed to send live notification to user {}, removing emitter", userId, e);
        emitters.remove(userId);
      }
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

    emitters.forEach(
        (uId, emitter) -> {
          try {
            emitter.send(
                SseEmitter.event()
                    .name(Objects.requireNonNull(eventName))
                    .data(Objects.requireNonNull(jsonPayload)));
          } catch (IOException e) {
            log.error("Failed to send event to user {}, removing emitter", uId, e);
            emitters.remove(uId);
          }
        });
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

    SseEmitter emitter = emitters.get(userId);
    if (emitter != null) {
      try {
        emitter.send(
            SseEmitter.event()
                .name(Objects.requireNonNull(eventName))
                .data(Objects.requireNonNull(jsonPayload)));
      } catch (IOException e) {
        log.error("Failed to send live event to user {}, removing emitter", userId, e);
        emitters.remove(userId);
      }
    }
  }
}
