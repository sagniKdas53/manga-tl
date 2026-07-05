package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
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
public class SseServiceTest {

  @Mock private StringRedisTemplate redisTemplate;
  @Mock private ListOperations<String, String> listOps;
  @Mock private ValueOperations<String, String> valOps;
  @Mock private ImageRepository imageRepository;

  private ObjectMapper objectMapper = new ObjectMapper();
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
}
