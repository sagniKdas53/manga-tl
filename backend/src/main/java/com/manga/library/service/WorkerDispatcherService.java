package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
@Slf4j
public class WorkerDispatcherService {

  @Value("${WORKER_URLS:http://worker:9091}")
  private String workerUrlsConfig;

  @Value("${WORKER_API_SECRET:}")
  private String workerApiSecret;

  @Value("${WORKER_API_SECRET_FILE:}")
  private String workerApiSecretFile;

  @PostConstruct
  public void init() {
    if (workerApiSecretFile != null && !workerApiSecretFile.isEmpty()) {
      try {
        workerApiSecret = Files.readString(Path.of(workerApiSecretFile)).trim();
        log.info("Loaded WORKER_API_SECRET from file");
      } catch (Exception e) {
        log.error("Failed to read WORKER_API_SECRET_FILE", e);
      }
    }
  }

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;

  private final HttpClient httpClient =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

  private final List<String> HEAVY_QUEUES =
      List.of("queue:qa-re-ocr", "queue:region-redo-ocr", "queue:ocr", "queue:panel-detection");

  private final List<String> LIGHT_QUEUES =
      List.of(
          "queue:region-redo-tl", "queue:qa", "queue:render", "queue:translation", "queue:layout");

  @Scheduled(fixedDelay = 2000)
  public void dispatchJobs() {
    if (redisTemplate == null || redisTemplate.opsForValue() == null) {
      return;
    }
    String paused = redisTemplate.opsForValue().get("system:queue:paused");
    if ("true".equals(paused)) {
      return;
    }

    List<String> workerUrls = new ArrayList<>();
    if (workerUrlsConfig != null) {
      for (String url : workerUrlsConfig.split(",")) {
        String trimmed = url.trim();
        if (!trimmed.isEmpty()) {
          workerUrls.add(trimmed);
        }
      }
    }
    if (workerUrls.isEmpty()) {
      return;
    }

    dispatchFromSlot(HEAVY_QUEUES, workerUrls);
    dispatchFromSlot(LIGHT_QUEUES, workerUrls);
  }

  private void dispatchFromSlot(List<String> queues, List<String> workerUrls) {
    for (String queue : queues) {
      boolean processed = true;
      while (processed) {
        processed = false;

        String jobJson = redisTemplate.opsForList().leftPop(queue);
        if (jobJson == null) continue;

        boolean sent = false;
        for (String workerUrl : workerUrls) {
          try {
            String targetUrl = workerUrl.trim() + "/api/v1/jobs/submit";
            Map<String, Object> payload = new HashMap<>();
            payload.put("queue_name", queue);
            payload.put("job_data", objectMapper.readValue(jobJson, Map.class));

            HttpRequest.Builder requestBuilder =
                HttpRequest.newBuilder()
                    .uri(URI.create(targetUrl))
                    .timeout(Duration.ofSeconds(30))
                    .header("Content-Type", "application/json")
                    .POST(
                        HttpRequest.BodyPublishers.ofString(
                            objectMapper.writeValueAsString(payload)));

            if (workerApiSecret != null && !workerApiSecret.isEmpty()) {
              requestBuilder.header("WORKER_API_SECRET", workerApiSecret);
            }

            HttpResponse<String> response =
                httpClient.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 202) {
              sent = true;
              processed = true;
              break;
            } else if (response.statusCode() != 429) {
              log.error("Worker {} returned status {}", targetUrl, response.statusCode());
            }
          } catch (Exception e) {
            log.debug("Worker {} is unreachable: {}", workerUrl, e.getMessage());
          }
        }

        if (!sent) {
          redisTemplate.opsForList().leftPush(queue, jobJson);
          return;
        }
      }
    }
  }
}
