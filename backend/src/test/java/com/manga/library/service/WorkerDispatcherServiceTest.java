package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.model.Job;
import com.manga.library.repository.JobRepository;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;
import org.springframework.data.redis.core.ListOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.util.ReflectionTestUtils;

@SuppressWarnings("null")
public class WorkerDispatcherServiceTest {

  @Mock
  private StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper = new ObjectMapper();
  @Mock
  private HttpClient httpClient;
  @Mock
  private ValueOperations<String, String> valueOps;
  @Mock
  private ListOperations<String, String> listOps;
  @Mock
  private JobRepository jobRepository;
  @Mock
  private SseService sseService;

  @InjectMocks
  private WorkerDispatcherService workerDispatcherService;

  @BeforeEach
  public void setUp() {
    MockitoAnnotations.openMocks(this);
    when(redisTemplate.opsForValue()).thenReturn(valueOps);
    when(redisTemplate.opsForList()).thenReturn(listOps);
    when(listOps.size(anyString())).thenReturn(1L);

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

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(202);
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    // Verify it popped the job and didn't push it back
    verify(listOps, times(2)).leftPop("queue:panel-detection");
    verify(listOps, never()).leftPush(anyString(), anyString());
    verify(httpClient, times(2)).send(any(HttpRequest.class), any());
  }

  @Test
  public void testDispatchJobs_RateLimited() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}");

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(429);
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    // Verify it pushed the job back to the left
    verify(listOps).rightPush("queue:panel-detection", "{\"id\": \"123\"}");
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_MultipleWorkers_FirstFailsSecondAccepts() throws Exception {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerUrlsConfig", "http://worker1:9091,http://worker2:9091");
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> mockResponse1 = mockGeneric(HttpResponse.class);
    when(mockResponse1.statusCode()).thenReturn(429);
    HttpResponse<String> mockResponse2 = mockGeneric(HttpResponse.class);
    when(mockResponse2.statusCode()).thenReturn(202);

    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse, capResponse, mockResponse1, mockResponse2);

    workerDispatcherService.dispatchJobs();

    // Verify it popped the job and didn't push it back (because worker2 accepted
    // it)
    verify(listOps, times(2)).leftPop("queue:panel-detection");
    verify(listOps, never()).leftPush(anyString(), anyString());
    verify(httpClient, times(4)).send(any(HttpRequest.class), any());
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_MultipleWorkers_AllFail() throws Exception {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerUrlsConfig", "http://worker1:9091,http://worker2:9091");
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}");

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(429);

    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse, capResponse, mockResponse, mockResponse);

    workerDispatcherService.dispatchJobs();

    // Verify it pushed the job back to the left because all workers
    // failed/rate-limited
    verify(listOps).rightPush("queue:panel-detection", "{\"id\": \"123\"}");
    verify(httpClient, times(4)).send(any(HttpRequest.class), any());
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_MultipleWorkers_FirstThrowsExceptionSecondAccepts()
      throws Exception {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerUrlsConfig", "http://worker1:9091,http://worker2:9091");
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(202);

    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse, capResponse)
        .thenThrow(new java.io.IOException("Connection refused"))
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    // Verify it popped the job and didn't push it back because worker2 accepted it
    verify(listOps, times(2)).leftPop("queue:panel-detection");
    verify(listOps, never()).leftPush(anyString(), anyString());
    verify(httpClient, times(4)).send(any(HttpRequest.class), any());
  }

  @Test
  public void testDispatchJobs_HeadersAndPayload() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(202);

    org.mockito.ArgumentCaptor<HttpRequest> requestCaptor = org.mockito.ArgumentCaptor.forClass(HttpRequest.class);
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        requestCaptor.capture(),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    HttpRequest request = requestCaptor.getValue();
    assertEquals("POST", request.method());
    assertEquals("http://worker:9091/api/v1/jobs/submit", request.uri().toString());
    assertEquals("application/json", request.headers().firstValue("Content-Type").orElse(null));
    assertEquals("test_secret", request.headers().firstValue("WORKER_API_SECRET").orElse(null));
  }

  @Test
  public void testInit_SecretFile() throws Exception {
    Path tempFile = Files.createTempFile("worker_secret", ".txt");
    Files.writeString(tempFile, "file_secret");

    ReflectionTestUtils.setField(
        workerDispatcherService, "workerApiSecretFile", tempFile.toString());
    workerDispatcherService.init();

    String secret = (String) ReflectionTestUtils.getField(workerDispatcherService, "workerApiSecret");
    assertEquals("file_secret", secret);

    Files.deleteIfExists(tempFile);
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_IndependentSlots_HeavyRejectedLightAccepted() throws Exception {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerUrlsConfig", "http://worker1:9091,http://worker2:9091");
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    when(listOps.leftPop("queue:qa-re-ocr")).thenReturn("{\"id\": \"heavy1\"}");
    when(listOps.leftPop("queue:region-redo-tl"))
        .thenReturn("{\"id\": \"light1\"}")
        .thenReturn(null);

    HttpResponse<String> heavyResponse = mockGeneric(HttpResponse.class);
    when(heavyResponse.statusCode()).thenReturn(429);
    HttpResponse<String> lightResponse = mockGeneric(HttpResponse.class);
    when(lightResponse.statusCode()).thenReturn(202);

    // Worker1: full capacity. Worker2: heavy slot full (no heavy slot), light slot
    // available.
    HttpResponse<String> capW1 = mockCapabilitiesResponse();
    HttpResponse<String> capW2 = mockCapabilitiesResponse(2, 0, 1, 1, 1, 0);
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capW1, capW2, heavyResponse, lightResponse);

    workerDispatcherService.dispatchJobs();

    // Heavy: worker1 429'd → only worker with heavy slot → pushed back.
    // Light: worker2 has light slot → accepted.
    verify(listOps).rightPush("queue:qa-re-ocr", "{\"id\": \"heavy1\"}");
    verify(listOps, times(2)).leftPop("queue:region-redo-tl");
    verify(listOps, never()).leftPush(eq("queue:region-redo-tl"), anyString());
  }

  @Test
  public void testDispatchJobs_IndependentSlots_LightRejectedHeavyAccepted() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    // Heavy queue has a job, light queue has a job
    when(listOps.leftPop("queue:qa-re-ocr")).thenReturn("{\"id\": \"heavy1\"}").thenReturn(null);
    when(listOps.leftPop("queue:region-redo-tl")).thenReturn("{\"id\": \"light1\"}");

    // First call (heavy) → 202, second call (light) → 429
    HttpResponse<String> heavyResponse = mockGeneric(HttpResponse.class);
    when(heavyResponse.statusCode()).thenReturn(202);
    HttpResponse<String> lightResponse = mockGeneric(HttpResponse.class);
    when(lightResponse.statusCode()).thenReturn(429);

    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(heavyResponse)
        .thenReturn(lightResponse);

    workerDispatcherService.dispatchJobs();

    // Heavy job was accepted, light job was pushed back
    verify(listOps, times(2)).leftPop("queue:qa-re-ocr");
    verify(listOps, never()).leftPush(eq("queue:qa-re-ocr"), anyString());
    verify(listOps).rightPush("queue:region-redo-tl", "{\"id\": \"light1\"}");
  }

  @Test
  public void testDispatchJobs_BothSlotsAccepted() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    when(listOps.leftPop("queue:qa-re-ocr")).thenReturn("{\"id\": \"heavy1\"}").thenReturn(null);
    when(listOps.leftPop("queue:region-redo-tl"))
        .thenReturn("{\"id\": \"light1\"}")
        .thenReturn(null);

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(202);
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(mockResponse)
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    verify(listOps, times(2)).leftPop("queue:qa-re-ocr");
    verify(listOps, times(2)).leftPop("queue:region-redo-tl");
    verify(listOps, never()).leftPush(anyString(), anyString());
    verify(httpClient, times(3)).send(any(HttpRequest.class), any());
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_BothSlotsRejected() throws Exception {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerUrlsConfig", "http://worker1:9091,http://worker2:9091");
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    when(listOps.leftPop("queue:qa-re-ocr")).thenReturn("{\"id\": \"heavy1\"}");
    when(listOps.leftPop("queue:region-redo-tl")).thenReturn("{\"id\": \"light1\"}");

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(429);

    // Worker1: full capacity. Worker2: heavy slot full (no heavy slot), light slot
    // available.
    HttpResponse<String> capW1 = mockCapabilitiesResponse();
    HttpResponse<String> capW2 = mockCapabilitiesResponse(2, 0, 1, 1, 1, 0);
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capW1, capW2, mockResponse, mockResponse);

    workerDispatcherService.dispatchJobs();

    // Heavy: worker1 429'd → only worker with heavy slot → pushed back.
    // Light: worker2 has light slot, 429'd → pushed back.
    verify(listOps).rightPush("queue:qa-re-ocr", "{\"id\": \"heavy1\"}");
    verify(listOps).rightPush("queue:region-redo-tl", "{\"id\": \"light1\"}");
  }

  @Test
  public void testDispatchJobs_PermanentRejection_400() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(400);
    when(mockResponse.body()).thenReturn("{\"detail\":\"bad request\"}");
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    // Job should be consumed, NOT re-queued (400 is permanent rejection)
    verify(listOps, never()).leftPush(anyString(), anyString());
  }

  @Test
  public void testDispatchJobs_PermanentRejection_422() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> mockResponse = mockGeneric(HttpResponse.class);
    when(mockResponse.statusCode()).thenReturn(422);
    when(mockResponse.body())
        .thenReturn("{\"detail\":[{\"msg\":\"field required\",\"type\":\"missing\"}]}");
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(mockResponse);

    workerDispatcherService.dispatchJobs();

    // Job should be consumed, NOT re-queued (422 is permanent validation failure)
    verify(listOps, never()).leftPush(anyString(), anyString());
  }

  /**
   * AUDIT-P2: a permanent rejection pops the job off Redis and never re-pushes it, so unless the DB
   * row is marked FAILED it sits PENDING forever — invisible to the stale-PROCESSING sweeper and
   * re-rejected on every backend restart, with no error anywhere in the UI.
   */
  @Test
  public void testDispatchJobs_PermanentRejection_MarksJobFailed() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    String jobId = UUID.randomUUID().toString();
    when(listOps.leftPop("queue:panel-detection"))
        .thenReturn("{\"jobId\": \"" + jobId + "\"}")
        .thenReturn(null);

    Job job = new Job();
    job.setId(jobId);
    job.setType("panel-detection");
    job.setStatus("PENDING");
    job.setImageId(UUID.randomUUID());
    when(jobRepository.findById(jobId)).thenReturn(java.util.Optional.of(job));

    HttpResponse<String> rejected = mockGeneric(HttpResponse.class);
    when(rejected.statusCode()).thenReturn(422);
    when(rejected.body()).thenReturn("{\"detail\":[{\"msg\":\"field required\"}]}");
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(rejected);

    workerDispatcherService.dispatchJobs();

    assertEquals("FAILED", job.getStatus(), "a permanently rejected job must not stay PENDING");
    assertNotNull(job.getError(), "the rejection reason must reach the jobs.error column");
    assertTrue(job.getError().contains("422"), "the error should name the rejecting status");
    verify(jobRepository).save(job);
    verify(sseService).emitEventForImage(job.getImageId(), "job_update", job);
  }

  /** A rejection with no resolvable job row must not blow up the dispatch cycle. */
  @Test
  public void testDispatchJobs_PermanentRejection_UnknownJobIdIsSurvivable() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> rejected = mockGeneric(HttpResponse.class);
    when(rejected.statusCode()).thenReturn(400);
    when(rejected.body()).thenReturn("bad request");
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(rejected);

    assertDoesNotThrow(() -> workerDispatcherService.dispatchJobs());
    verify(jobRepository, never()).save(any(Job.class));
  }

  /**
   * AUDIT-P3: an undispatchable job used to abandon the whole slot class. HEAVY_QUEUES is ordered
   * [qa-re-ocr, region-redo-ocr, ocr, panel-detection], so one stuck job on qa-re-ocr stopped
   * queue:ocr being polled at all that cycle. A 500 is used rather than a 429 because a 429 also
   * drops the worker from the capacity map, which would mask the defect under test.
   */
  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_StuckQueueDoesNotBlockTheRestOfItsSlotClass() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:qa-re-ocr")).thenReturn("{\"id\": \"stuck\"}").thenReturn(null);
    when(listOps.leftPop("queue:ocr")).thenReturn("{\"id\": \"behind-it\"}").thenReturn(null);

    HttpResponse<String> serverError = mockGeneric(HttpResponse.class);
    when(serverError.statusCode()).thenReturn(500);
    when(serverError.body()).thenReturn("internal error");
    HttpResponse<String> accepted = mockGeneric(HttpResponse.class);
    when(accepted.statusCode()).thenReturn(202);
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse, serverError, accepted);

    workerDispatcherService.dispatchJobs();

    // The stuck job goes back on its own queue...
    verify(listOps).rightPush("queue:qa-re-ocr", "{\"id\": \"stuck\"}");
    // ...and the queue behind it in the same slot class is still polled and dispatched.
    verify(listOps, atLeastOnce()).leftPop("queue:ocr");
    verify(listOps, never()).rightPush(eq("queue:ocr"), anyString());
  }

  @Test
  public void testDispatchJobs_NullRedis() {
    WorkerDispatcherService svc =
        new WorkerDispatcherService(null, objectMapper, jobRepository, sseService);
    assertDoesNotThrow(() -> svc.dispatchJobs());
  }

  @Test
  public void testDispatchJobs_EmptyWorkerUrls() {
    ReflectionTestUtils.setField(workerDispatcherService, "workerUrlsConfig", "");
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    workerDispatcherService.dispatchJobs();

    verify(listOps, never()).leftPop(anyString());
  }

  @Test
  public void testDispatchJobs_NoQueueItems() {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.size(anyString())).thenReturn(0L);

    workerDispatcherService.dispatchJobs();

    verify(listOps, never()).leftPop(anyString());
  }

  @Test
  public void testDispatchJobs_AllWorkersInCooldown() {
    Map<String, Instant> cooldowns =
        (Map<String, Instant>) ReflectionTestUtils.getField(workerDispatcherService, "workerCooldowns");
    cooldowns.put("http://worker:9091", Instant.now().plusSeconds(60));
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    workerDispatcherService.dispatchJobs();

    verify(listOps, never()).leftPop(anyString());
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_CapabilitiesQueryFails() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenThrow(new java.io.IOException("Connection refused"));

    workerDispatcherService.dispatchJobs();

    verify(listOps, never()).leftPop(anyString());
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_LightSlotFull() throws Exception {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerUrlsConfig", "http://worker1:9091,http://worker2:9091");
    when(valueOps.get("system:queue:paused")).thenReturn("false");

    // Heavy queues are empty (unstubbed leftPop returns null), so only light runs.
    when(listOps.leftPop("queue:region-redo-tl")).thenReturn("{\"id\": \"light1\"}");

    HttpResponse<String> capW1 = mockCapabilitiesResponse(2, 0, 1, 0, 1, 0);
    HttpResponse<String> capW2 = mockCapabilitiesResponse(2, 0, 1, 0, 1, 1);
    HttpResponse<String> rateLimited = mockGeneric(HttpResponse.class);
    when(rateLimited.statusCode()).thenReturn(429);
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capW1, capW2, rateLimited);

    workerDispatcherService.dispatchJobs();

    verify(listOps).rightPush("queue:region-redo-tl", "{\"id\": \"light1\"}");
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_ServerError500() throws Exception {
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}");

    HttpResponse<String> serverError = mockGeneric(HttpResponse.class);
    when(serverError.statusCode()).thenReturn(500);
    when(serverError.body()).thenReturn("internal error");
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(serverError);

    workerDispatcherService.dispatchJobs();

    verify(listOps).rightPush("queue:panel-detection", "{\"id\": \"123\"}");
  }

  @Test
  public void testInit_SecretFileReadError() {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerApiSecretFile", "/nonexistent/path/secret.txt");
    assertDoesNotThrow(() -> workerDispatcherService.init());
  }

  @Test
  @SuppressWarnings("unchecked")
  public void testDispatchJobs_TrailingSlashWorkerUrl() throws Exception {
    ReflectionTestUtils.setField(
        workerDispatcherService, "workerUrlsConfig", "http://worker:9091/");
    when(valueOps.get("system:queue:paused")).thenReturn("false");
    when(listOps.leftPop("queue:panel-detection")).thenReturn("{\"id\": \"123\"}").thenReturn(null);

    HttpResponse<String> accepted = mockGeneric(HttpResponse.class);
    when(accepted.statusCode()).thenReturn(202);
    HttpResponse<String> capResponse = mockCapabilitiesResponse();
    when(httpClient.send(
        any(HttpRequest.class),
        org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(capResponse)
        .thenReturn(accepted);

    workerDispatcherService.dispatchJobs();

    verify(listOps, times(2)).leftPop("queue:panel-detection");
  }

  @SuppressWarnings("unchecked")
  private <T> T mockGeneric(Class<?> clazz) {
    return (T) org.mockito.Mockito.mock(clazz);
  }

  private HttpResponse<String> mockCapabilitiesResponse() {
    return mockCapabilitiesResponse(2, 0, 1, 0, 1, 0);
  }

  private HttpResponse<String> mockCapabilitiesResponse(
      int maxTotal, int activeTotal, int maxHeavy, int activeHeavy, int maxLight, int activeLight) {
    HttpResponse<String> cap = mockGeneric(HttpResponse.class);
    when(cap.statusCode()).thenReturn(200);
    when(cap.body())
        .thenReturn(
            String.format(
                "{\"max_concurrent_jobs\": %d, \"active_jobs\": %d, \"max_heavy_slots\": %d, \"active_heavy_jobs\": %d, \"max_light_slots\": %d, \"active_light_jobs\": %d}",
                maxTotal, activeTotal, maxHeavy, activeHeavy, maxLight, activeLight));
    return cap;
  }
}
