package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;
import org.springframework.data.redis.core.ListOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.util.ReflectionTestUtils;

public class WorkerDispatcherServiceTest {

  @Mock private StringRedisTemplate redisTemplate;
  private ObjectMapper objectMapper = new ObjectMapper();
  @Mock private HttpClient httpClient;
  @Mock private ValueOperations<String, String> valueOps;
  @Mock private ListOperations<String, String> listOps;

  @InjectMocks private WorkerDispatcherService workerDispatcherService;

  @BeforeEach
  public void setUp() {
    MockitoAnnotations.openMocks(this);
    when(redisTemplate.opsForValue()).thenReturn(valueOps);
    when(redisTemplate.opsForList()).thenReturn(listOps);

    ReflectionTestUtils.setField(workerDispatcherService, "workerUrlsConfig", "http://worker:9091");
    ReflectionTestUtils.setField(workerDispatcherService, "workerApiSecret", "test_secret");

    // Replace the internally created HttpClient with our mock
    ReflectionTestUtils.setField(workerDispatcherService, "httpClient", httpClient);
    ReflectionTestUtils.setField(workerDispatcherService, "objectMapper", objectMapper);
  }

  @Test
  public void testDispatchJobs_Paused() {
    when(valueOps.get("system:queue:paused")).thenReturn("true");
    workerDispatcherService.dispatchJobs();
    verify(listOps, never()).leftPop(anyString());
  }

  @Test
  public void testDispatchJobs_Accepted() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> mockResponse = mock(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(202);
    when(httpClient.send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class)))
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    // Verify it popped the job and didn't push it back
    verify(listOps, times(2)).leftPop("queue:panel-detection");
    verify(listOps, never()).leftPush(anyString(), anyString());
    verify(httpClient, times(1)).send(any(HttpRequest.class), any());
  }

  @Test
  public void testDispatchJobs_RateLimited() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}");

    HttpResponse<String> mockResponse = mock(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(429);
    when(httpClient.send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class)))
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    // Verify it pushed the job back to the left
    verify(listOps).leftPush("queue:panel-detection", "{\"id\": \"123\"}");
  }

  @Test
  public void testInit_SecretFile() throws Exception {
    Path tempFile = Files.createTempFile("worker_secret", ".txt");
    Files.writeString(tempFile, "file_secret");

    ReflectionTestUtils.setField(
        workerDispatcherService, "workerApiSecretFile", tempFile.toString());
    workerDispatcherService.init();

    String secret =
        (String) ReflectionTestUtils.getField(workerDispatcherService, "workerApiSecret");
    assertEquals("file_secret", secret);

    Files.deleteIfExists(tempFile);
  }
}
