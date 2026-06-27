package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.List;
import java.util.Map;
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
  private final ConcurrentHashMap<UUID, SseEmitter> emitters = new ConcurrentHashMap<>();

  private static final String NOTIFICATION_PREFIX = "notifications:user:";
  private static final String IMAGE_USER_MAPPING_PREFIX = "job:owner:image:";
  private static final Long EMITTER_TIMEOUT = 3600000L; // 1 hour

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
          emitter.completeWithError(e);
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
            emitter.send(SseEmitter.event().name("notification").data(notifJson));
          } catch (IOException e) {
            log.error("Failed to send pending notification to user {}", userId, e);
            return; // If it fails, keep remaining in Redis
          }
        }
      }
      redisTemplate.delete(key);
    }
  }

  public void mapImageToUser(UUID imageId, UUID userId) {
    redisTemplate
        .opsForValue()
        .set(
            IMAGE_USER_MAPPING_PREFIX + imageId, userId.toString(), java.time.Duration.ofHours(24));
  }

  public void emitNotificationForImage(UUID imageId, String type, String title, String message) {
    String userIdStr = redisTemplate.opsForValue().get(IMAGE_USER_MAPPING_PREFIX + imageId);
    if (userIdStr != null) {
      emitNotificationToUser(UUID.fromString(userIdStr), type, title, message, imageId);
    } else {
      log.warn(
          "Could not find owner user for image {} in Redis. Cannot send SSE notification.",
          imageId);
    }
  }

  public void emitNotificationToUser(UUID userId, String type, String title, String message) {
    emitNotificationToUser(userId, type, title, message, null);
  }

  public void emitNotificationToUser(
      UUID userId, String type, String title, String message, UUID imageId) {
    Map<String, Object> notification = new java.util.HashMap<>();
    notification.put("id", UUID.randomUUID().toString());
    notification.put("type", type);
    notification.put("title", title);
    notification.put("message", message);
    notification.put("timestamp", System.currentTimeMillis());
    if (imageId != null) {
      notification.put("imageId", imageId.toString());
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
        emitter.send(SseEmitter.event().name("notification").data(jsonPayload));
        return;
      } catch (IOException e) {
        log.error("Failed to send live notification to user {}, removing emitter", userId, e);
        emitters.remove(userId);
      }
    }

    String key = NOTIFICATION_PREFIX + userId;
    redisTemplate.opsForList().rightPush(key, jsonPayload);
    redisTemplate.expire(key, java.time.Duration.ofDays(7));
  }
}
