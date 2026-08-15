package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.TraceContext;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.function.Consumer;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class JobCoordinatorService {
  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(JobCoordinatorService.class);

  /**
   * TTL for the {@code image:{ocr,translation}:reason:} keys, which label the layer a redo produces.
   *
   * <p>AUDIT-P7: these were written without one. The consumer deletes the key after reading it, so
   * the only way one survives is a pipeline that dies before its callback — and then it sits there
   * forever and mislabels whatever run comes next. A day is far longer than any pipeline that is
   * still alive and far shorter than the gap to a run that has nothing to do with this one.
   */
  private static final Duration REDO_REASON_TTL = Duration.ofHours(24);

  /**
   * TTL for {@code pipeline:trace:}, the key that keeps every stage of one image's pipeline under a
   * single trace id.
   *
   * <p>AUDIT-P8: this was two hours, measured from {@code startPipeline} and never refreshed. The
   * run in {@code logs/run-3-fresh.log} took about that long for 50 pages, so the key expired
   * mid-pipeline, {@link #enqueueJobDirectly} minted a fresh id for the remaining stages, and the
   * trace silently split in two — the one thing the key exists to prevent.
   *
   * <p>The window is refreshed on every enqueue, so it now has to outlive a single *stage* rather
   * than a whole pipeline; the bound is what stops a pipeline that dies between stages from leaking
   * the key. Twelve hours is far longer than any stage that is still alive (the worker's own stale
   * sweeper gives up after ten minutes) and still expires within a day.
   */
  private static final Duration PIPELINE_TRACE_TTL = Duration.ofHours(12);

  public record ResolvedPipelineConfig(
      String ocrProvider, String ocrModel,
      String tlProvider, String tlModel,
      String qaProvider, String qaLlmModel, String qaVlmModel, String qaMode
  ) {}

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;
  private final ImageRepository imageRepository;
  private final PanelRepository panelRepository;
  private final OcrRegionRepository ocrRegionRepository;
  private final ConversationRepository conversationRepository;
  private final ConversationRegionRepository conversationRegionRepository;
  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final PageRepository pageRepository;
  private final SseService sseService;
  private final SystemSettingsService systemSettingsService;
  private final JobRepository jobRepository;
  private final JobCostRepository jobCostRepository;
  private final ProviderConfigCache providerConfigCache;

  public JobCoordinatorService(
      StringRedisTemplate redisTemplate,
      ObjectMapper objectMapper,
      ImageRepository imageRepository,
      PanelRepository panelRepository,
      OcrRegionRepository ocrRegionRepository,
      ConversationRepository conversationRepository,
      ConversationRegionRepository conversationRegionRepository,
      LayerRepository layerRepository,
      LayerElementRepository layerElementRepository,
      PageRepository pageRepository,
      SseService sseService,
      SystemSettingsService systemSettingsService,
      JobRepository jobRepository,
      JobCostRepository jobCostRepository,
      ProviderConfigCache providerConfigCache) {
    this.redisTemplate = redisTemplate;
    this.objectMapper = objectMapper;
    this.imageRepository = imageRepository;
    this.panelRepository = panelRepository;
    this.ocrRegionRepository = ocrRegionRepository;
    this.conversationRepository = conversationRepository;
    this.conversationRegionRepository = conversationRegionRepository;
    this.layerRepository = layerRepository;
    this.layerElementRepository = layerElementRepository;
    this.pageRepository = pageRepository;
    this.sseService = sseService;
    this.systemSettingsService = systemSettingsService;
    this.jobRepository = jobRepository;
    this.jobCostRepository = jobCostRepository;
    this.providerConfigCache = providerConfigCache;
  }

  /**
   * This bean as Spring exposes it, rather than {@code this} (AUDIT-B2).
   *
   * <p>{@code @Transactional} is applied by a proxy that wraps the bean. A plain {@code this.foo()}
   * call never leaves the object, so it never crosses that proxy and the annotation does nothing —
   * silently, with nothing at the call site to suggest it. {@code @Lazy} breaks the self-reference
   * cycle at construction time.
   */
  @org.springframework.beans.factory.annotation.Autowired
  @org.springframework.context.annotation.Lazy
  private JobCoordinatorService self;

  @EventListener(ApplicationReadyEvent.class)
  public void onStartup() {
    log.info("Application started. Resetting orphaned processing jobs and requeuing...");
    try {
      // Through the proxy, so the @Transactional on the target method actually applies.
      self.resetProcessingJobsToPending();
      String paused = null;
      if (redisTemplate != null && redisTemplate.opsForValue() != null) {
        paused = redisTemplate.opsForValue().get("system:queue:paused");
      }
      if (!"true".equals(paused)) {
        requeuePendingJobs();
      } else {
        log.info("Queue is globally paused. Skipping requeue.");
      }
    } catch (Exception e) {
      log.error("Failed to recover/requeue jobs on startup: {}", e.getMessage());
    }
  }

  /**
   * Migrates orphaned PROCESSING jobs back to PENDING at boot, as one transaction.
   *
   * <p>Exceptions deliberately propagate. Catching them here would leave the transaction to commit
   * whatever the loop managed before the failure — which is the half-migrated job table the
   * transaction exists to prevent. {@link #onStartup()} logs and carries on, so a failure here
   * still does not stop the application from starting.
   */
  @Transactional
  public void resetProcessingJobsToPending() {
    List<Job> processingJobs = jobRepository.findByStatusOrderByCreatedAtAsc("PROCESSING");
    for (Job job : processingJobs) {
        int attempt = job.getAttempt() != null ? job.getAttempt() + 1 : 1;
        int maxAttempts = job.getMaxAttempts() != null ? job.getMaxAttempts() : 3;
        if (attempt > maxAttempts) {
          log.warn(
              "Startup: Job {} exhausted max attempts ({}/{}), marking FAILED",
              job.getId(), attempt - 1, maxAttempts);
          job.setStatus("FAILED");
          job.setError(
              "Max attempts exhausted (" + (attempt - 1) + "/" + maxAttempts + ") on startup");
        } else {
          log.info("Resetting processing job {} to PENDING on startup (attempt {}/{})",
              job.getId(), attempt, maxAttempts);
          job.setStatus("PENDING");
          // Back in the queue, so it has not started. Leaving the abandoned attempt's timestamp
          // would charge its wall-clock — including however long the backend was down — to the
          // retry's work time.
          job.setStartedAt(null);
          job.setAttempt(attempt);
          job.setPayload(updatePayloadAttempt(job.getPayload(), attempt));
        }
        jobRepository.save(Objects.requireNonNull(job));
    }
  }

  @org.springframework.scheduling.annotation.Scheduled(fixedRate = 300000)
  @Transactional
  public void recoverStaleProcessingJobs() {
    try {
      OffsetDateTime threshold = OffsetDateTime.now().minusMinutes(10);
      List<Job> processingJobs = jobRepository.findByStatusOrderByCreatedAtAsc("PROCESSING");

      for (Job job : processingJobs) {
        if (job.getUpdatedAt() != null && job.getUpdatedAt().isBefore(threshold)) {
          int attempt = job.getAttempt() != null ? job.getAttempt() + 1 : 1;
          int maxAttempts = job.getMaxAttempts() != null ? job.getMaxAttempts() : 3;
          log.warn(
              "Recovering stale PROCESSING job {} (attempt {}/{}, last updated at {})",
              job.getId(), attempt, maxAttempts, job.getUpdatedAt());
          if (attempt > maxAttempts) {
            log.warn(
                "Job {} exhausted max attempts ({}/{}), marking FAILED instead of requeuing",
                job.getId(), attempt - 1, maxAttempts);
            job.setStatus("FAILED");
            job.setError("Max attempts exhausted after stale recovery");
          } else {
            job.setStatus("PENDING");
            job.setStartedAt(null);
            job.setAttempt(attempt);
            job.setPayload(updatePayloadAttempt(job.getPayload(), attempt));
          }
          jobRepository.save(Objects.requireNonNull(job));
          if ("PENDING".equals(job.getStatus())) {
            pushPersistedJobIfQueueRunning(job);
          }
        }
      }
    } catch (Exception e) {
      log.error("Failed to recover stale processing jobs: {}", e.getMessage());
    }
  }

  /**
   * Resolves the target {@link Page} for a job callback. When {@code pageId} is
   * provided (as sent
   * by the worker in callback payloads), it is used directly for a precise lookup
   * — this is the
   * correct behaviour when the same image is referenced by multiple chapters.
   * Falls back to
   * {@code findByImageId().stream().findFirst()} only when no pageId is
   * available.
   */
  private Page resolvePageForCallback(UUID imageId, UUID pageId) {
    if (pageId != null) {
      return pageRepository.findById(pageId).orElse(null);
    }
    return pageRepository.findByImageId(imageId).stream().findFirst().orElse(null);
  }

  /**
   * Resolves the {@link Job} row a callback is reporting on.
   *
   * <p>AUDIT-P5: {@code enqueueJobDirectly} mints a {@code jobId}, stores it as the row's primary
   * key and puts it in the worker payload, and the worker echoes it back on the callback. That is
   * an exact answer, so prefer it. The fallback — newest job of this type for this image — is a
   * guess, and it is wrong whenever a redo is in flight or an image backs pages in two chapters.
   * It is kept only for callbacks that carry no {@code jobId}: a worker older than this change, or
   * one of the internal call sites that has no job row of its own.
   *
   * <p>A {@code jobId} that resolves to a row of a different type is not trusted — that would mean
   * the callback reached the wrong endpoint, and claiming it would mis-mark an unrelated job. Warn
   * and fall back rather than act on it.
   */
  private Job resolveCallbackJob(String jobId, UUID imageId, String jobType) {
    if (jobId != null && !jobId.isBlank()) {
      Job job = jobRepository.findById(jobId).orElse(null);
      if (job != null && jobType.equals(job.getType())) {
        return job;
      }
      if (job == null) {
        log.warn(
            "{} callback for image {} carried jobId {}, but no such job row exists — "
                + "falling back to the newest {} job for the image",
            jobType,
            imageId,
            jobId,
            jobType);
      } else {
        log.warn(
            "{} callback for image {} carried jobId {}, but that job is of type {} — "
                + "refusing to claim it, falling back to the newest {} job for the image",
            jobType,
            imageId,
            jobId,
            job.getType(),
            jobType);
      }
    }
    if (imageId == null) {
      return null;
    }
    return jobRepository.findFirstByImageIdAndTypeOrderByCreatedAtDesc(imageId, jobType);
  }

  /**
   * Marks the job a callback belongs to FAILED and pushes the update down the stream, so a stage
   * that cannot proceed shows an error in the UI instead of stalling.
   */
  private void failJob(String jobId, UUID imageId, String type, String error) {
    Job job = resolveCallbackJob(jobId, imageId, type);
    if (job == null) {
      log.warn("No {} job row found for image {} — cannot mark it FAILED", type, imageId);
      return;
    }
    job.setStatus("FAILED");
    job.setError(error);
    job.setUpdatedAt(OffsetDateTime.now());
    jobRepository.save(job);
    sseService.emitEventForImage(imageId, "job_update", job);
  }

  /**
   * Safely extracts a UUID value from a map by key. Returns null if missing or
   * unparsable.
   */
  private UUID extractUuid(Map<String, Object> map, String key) {
    if (map == null || !map.containsKey(key) || map.get(key) == null)
      return null;
    try {
      return UUID.fromString(map.get(key).toString());
    } catch (IllegalArgumentException e) {
      return null;
    }
  }

  @Transactional
  public void startPipeline(UUID imageId) {
    startPipeline(imageId, null);
  }

  @Transactional
  public void startPipeline(UUID imageId, UUID chapterId) {
    startPipeline(imageId, null, chapterId);
  }

  @Transactional
  public void startPipeline(UUID imageId, UUID pageId, UUID chapterId) {
    log.info(
        "Starting pipeline for image {} (page {}) and chapter {}", imageId, pageId, chapterId);
    if (redisTemplate != null && redisTemplate.opsForValue() != null) {
      String traceId = UUID.randomUUID().toString();
      redisTemplate
          .opsForValue()
          .set(
              Objects.requireNonNull("pipeline:trace:" + imageId),
              Objects.requireNonNull(traceId),
              Objects.requireNonNull(PIPELINE_TRACE_TTL));
      TraceContext.put(traceId);
      // The only place the full id is written. Every other line shows the 8-character prefix the
      // log pattern renders, so this is what bridges a grep back to jobs.trace_id.
      log.info("Pipeline trace for image {} is {}", imageId, traceId);
    }

    // Panels are a property of the Image, not the Page: panel detection is a purely
    // geometric step whose output is identical for every page that reuses this image,
    // and existing ocr_regions (possibly on other chapters' pages) reference those
    // panel rows. Re-running detection would try to delete rows that are still
    // referenced, so reuse them and start the pipeline at OCR instead.
    if (!panelRepository.findByImageId(imageId).isEmpty()) {
      log.info(
          "Panels already exist for image {} — reusing them and starting pipeline at OCR", imageId);
      enqueueJobDirectly("ocr", imageId, pageId, chapterId, "normal", job -> {
      });
      return;
    }

    enqueueJobDirectly("panel-detection", imageId, pageId, chapterId, "normal", job -> {
    });
  }

  private void enqueueJob(String jobType, UUID imageId, UUID chapterId) {
    enqueueJobDirectly(jobType, imageId, null, chapterId, "normal", job -> {
    });
  }

  /**
   * Enqueues the next pipeline stage for a specific page. The same image can back pages in several
   * chapters (duplicate upload), each with its own provider/model configuration, so every hand-off
   * between stages must carry the page it belongs to — otherwise the payload is built from whichever
   * page happens to come first for that image.
   */
  private void enqueueJobForPage(String jobType, UUID imageId, UUID pageId) {
    enqueueJobForPage(jobType, imageId, pageId, "normal", job -> {
    });
  }

  private void enqueueJobForPage(
      String jobType,
      UUID imageId,
      UUID pageId,
      String priority,
      Consumer<Map<String, Object>> payloadCustomizer) {
    enqueueJobDirectly(jobType, imageId, pageId, null, priority, payloadCustomizer);
  }

  private void enqueueJobDirectly(
      String jobType,
      UUID imageId,
      UUID pageId,
      UUID chapterId,
      String priority,
      Consumer<Map<String, Object>> payloadCustomizer) {
    try {
      String traceId = null;
      if (redisTemplate != null && redisTemplate.opsForValue() != null) {
        traceId = redisTemplate.opsForValue().get("pipeline:trace:" + imageId);
        if (traceId == null) {
          traceId = UUID.randomUUID().toString();
          redisTemplate
              .opsForValue()
              .set(
                  Objects.requireNonNull("pipeline:trace:" + imageId),
                  Objects.requireNonNull(traceId),
                  Objects.requireNonNull(PIPELINE_TRACE_TTL));
        } else {
          // AUDIT-P8: slide the window forward on every hand-off. Without this the TTL runs from
          // startPipeline, so a pipeline slower than the TTL loses its trace part-way through and
          // the branch above splits it under a new id.
          redisTemplate.expire(
              Objects.requireNonNull("pipeline:trace:" + imageId),
              Objects.requireNonNull(PIPELINE_TRACE_TTL));
        }
      } else {
        traceId = UUID.randomUUID().toString();
      }

      // Bind the pipeline's id to this thread so the enqueue logs below, and everything the caller
      // does after us, are greppable as one pipeline. Deliberately not cleared here: on a worker
      // callback this thread is already carrying the same id (TraceIdFilter read it off the
      // X-Trace-Id header), and on an upload path the caller has no id of its own to restore. The
      // request filter's finally block is what clears it.
      TraceContext.put(traceId);

      String jobId = UUID.randomUUID().toString();
      Job dbJob = new Job();
      dbJob.setId(jobId);
      dbJob.setTraceId(traceId);
      dbJob.setType(jobType);
      dbJob.setImageId(imageId);
      dbJob.setStatus("PENDING");
      dbJob.setAttempt(1);
      dbJob.setMaxAttempts(3);
      Map<String, Object> job = new HashMap<>();
      job.put("jobId", jobId);
      job.put("traceId", traceId);
      job.put("type", jobType);
      job.put("imageId", imageId.toString());
      job.put("priority", priority);
      job.put("attempt", 1);
      job.put("maxAttempts", 3);
      job.put("createdAt", OffsetDateTime.now().toString());

      // Resolve the page this job belongs to, most specific identifier first. Falling
      // back to "first page for this image" is only correct while an image backs a
      // single page; for duplicates it would silently pick another chapter's config.
      Optional<Page> pageOpt = Optional.empty();
      if (pageId != null) {
        pageOpt = pageRepository.findById(pageId);
      }
      if (pageOpt.isEmpty() && chapterId != null) {
        pageOpt = pageRepository.findByChapterIdAndImageId(chapterId, imageId);
      }
      if (pageOpt.isEmpty()) {
        List<Page> imagePages = pageRepository.findByImageId(imageId);
        if (imagePages.size() > 1) {
          log.warn(
              "Job {} for image {} has no page/chapter context but the image backs {} pages —"
                  + " falling back to the first one, configuration may be wrong",
              jobType,
              imageId,
              imagePages.size());
        }
        pageOpt = imagePages.stream().findFirst();
      }

      pageOpt.ifPresent(
          page -> {
            // Stamp the resolved identity so every downstream stage inherits it.
            job.put("pageId", page.getId().toString());
            if (page.getChapter() != null) {
              job.put("chapterId", page.getChapter().getId().toString());
            }
            if (page.getChapter() != null && page.getChapter().getSeries() != null) {
              Series series = page.getChapter().getSeries();
              Chapter chapter = page.getChapter();
              if (series.getReadingDirection() != null) {
                job.put("readingDirection", series.getReadingDirection().trim().toLowerCase());
              }
              if (series.getSourceLanguage() != null) {
                job.put("sourceLanguage", series.getSourceLanguage().trim().toLowerCase());
              }
              if (series.getTargetLanguage() != null) {
                job.put("targetLanguage", series.getTargetLanguage().trim().toLowerCase());
              }
              job.put("pageNumber", page.getPageNumber());
              job.put("chapterNumber", chapter.getChapterNumber());
              if (chapter.getTitle() != null)
                job.put("chapterTitle", chapter.getTitle());
              if (series.getTitle() != null)
                job.put("seriesTitle", series.getTitle());

              com.manga.library.dto.SystemSettingsDto settings = systemSettingsService.getSettings();

              String resolvedOcrProvider = resolveModel(
                  chapter.getOcrProvider(), series.getOcrProvider(), settings.ocrProvider());
              job.put("ocrProvider", resolvedOcrProvider);

              if ("local".equals(resolvedOcrProvider)) {
                // Local OCR now has real, selectable models (PP-OCRv6 / PP-OCRv5), so a chapter or
                // series override has to survive instead of being flattened to the global default.
                // The worker treats this as a preference: if the chosen pair has no recognition
                // model for the page's language it routes to one that does.
                job.put(
                    "ocrModel",
                    resolveModel(
                        chapter.getOcrModel(), series.getOcrModel(), settings.localOcrModel()));
              } else {
                job.put(
                    "ocrModel",
                    resolveModel(chapter.getOcrModel(), series.getOcrModel(), settings.ocrModel()));
              }
              String resolvedTlProvider = resolveModel(
                  chapter.getTlProvider(), series.getTlProvider(), settings.tlProvider());
              job.put("tlProvider", resolvedTlProvider);
              job.put(
                  "tlModel",
                  resolveModelWithCheck(
                      chapter.getTlModel(),
                      series.getTlModel(),
                      settings.tlModel(),
                      resolvedTlProvider,
                      "tl"));
              String resolvedQaProvider = resolveModel(
                  chapter.getQaProvider(), series.getQaProvider(), settings.qaProvider());
              job.put("qaProvider", resolvedQaProvider);
              String resolvedQaLlmModel = resolveModelWithCheck(
                  chapter.getQaLlmModel(),
                  series.getQaLlmModel(),
                  settings.qaLlmModel(),
                  resolvedQaProvider,
                  "qaLLM");
              job.put("qaLlmModel", resolvedQaLlmModel);
              job.put(
                  "routingStrategy",
                  resolveModel(
                      chapter.getRoutingStrategy(),
                      series.getRoutingStrategy(),
                      settings.routingStrategy()));
              String resolvedQaVlmModel = resolveModelWithCheck(
                  chapter.getQaVlmModel(),
                  series.getQaVlmModel(),
                  settings.qaVlmModel(),
                  resolvedQaProvider,
                  "qaVLM");
              job.put("qaVlmModel", resolvedQaVlmModel);
              String resolvedQaMode = resolveModel(chapter.getQaMode(), series.getQaMode(), settings.qaMode());
              boolean vlmUsable = hasUsableModel(resolvedQaProvider, resolvedQaVlmModel, "qaVLM");
              boolean llmUsable = hasUsableModel(resolvedQaProvider, resolvedQaLlmModel, "qaLLM");

              // -------------------------------------------------------------------------------------
              // MODEL INHERITANCE LOGIC & SMART ROUTING:
              // - Mode "auto" prefers VLM over LLM. If VLM is not supported by the provider,
              // it automatically falls back to LLM.
              // - Explicit modes ("vlm" or "llm") will also gracefully fallback to the other
              // if the requested mode is unsupported by the current provider.
              // -------------------------------------------------------------------------------------
              if ("auto".equalsIgnoreCase(resolvedQaMode)) {
                if (vlmUsable) {
                  resolvedQaMode = "vlm";
                } else if (llmUsable) {
                  resolvedQaMode = "llm";
                }
              } else if ("vlm".equalsIgnoreCase(resolvedQaMode) && !vlmUsable && llmUsable) {
                log.warn("VLM mode explicitly requested but not available for provider '{}'. Falling back to LLM.",
                    resolvedQaProvider);
                resolvedQaMode = "llm";
              } else if ("llm".equalsIgnoreCase(resolvedQaMode) && !llmUsable && vlmUsable) {
                log.warn("LLM mode explicitly requested but not available for provider '{}'. Falling back to VLM.",
                    resolvedQaProvider);
                resolvedQaMode = "vlm";
              }

              if (!"auto".equalsIgnoreCase(resolvedQaMode)) {
                // DEBUG: re-resolved identically on every stage hand-off, so at INFO this printed
                // three times per page saying the same thing. Useful when model routing is the
                // thing under investigation, which is what the loggers endpoint is for.
                log.debug(
                    "QA mode resolved to '{}' for image {} (provider={}, vlmModel='{}', llmModel='{}')",
                    resolvedQaMode,
                    imageId,
                    resolvedQaProvider,
                    resolvedQaVlmModel,
                    resolvedQaLlmModel);
              }
              job.put("qaMode", resolvedQaMode);

              // useFallbackModels: chapter overrides series overrides global; null = inherit
              Boolean chapterFallback = chapter.getUseFallbackModels();
              Boolean seriesFallback = series.getUseFallbackModels();
              boolean resolvedFallback;
              if (chapterFallback != null) {
                resolvedFallback = chapterFallback;
              } else if (seriesFallback != null) {
                resolvedFallback = seriesFallback;
              } else {
                // Fall through to global setting (default true if not configured)
                resolvedFallback = settings.useFallbackModels() == null || settings.useFallbackModels();
              }
              job.put("useFallbackModels", resolvedFallback);
            }
          });

      payloadCustomizer.accept(job);

      String json = objectMapper.writeValueAsString(job);
      dbJob.setPayload(json);
      jobRepository.save(Objects.requireNonNull(dbJob));

      // Emit real-time SSE event for the new job
      sseService.emitEventForImage(imageId, "job_update", dbJob);

      enqueuePersistedJob(dbJob);
    } catch (Exception e) {
      log.error("Failed to enqueue job for image {}", imageId, e);
    }
  }

  private void enqueuePersistedJob(Job dbJob) {
    if (TransactionSynchronizationManager.isActualTransactionActive()) {
      // DEBUG, not INFO: this is mechanism, not outcome. It fires on every hand-off between the six
      // pipeline stages and reports only which of two code paths was taken.
      log.debug(
          "Transaction active. Deferring Redis push of {} job {} until commit",
          dbJob.getType(),
          dbJob.getId());
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCommit() {
              pushPersistedJobIfQueueRunning(dbJob);
            }
          });
    } else {
      pushPersistedJobIfQueueRunning(dbJob);
    }
  }

  private void pushPersistedJobIfQueueRunning(Job dbJob) {
    try {
      String paused = redisTemplate.opsForValue().get("system:queue:paused");
      if (!"true".equals(paused)) {
        pushJobToRedis(dbJob);
      } else {
        log.info("Queue is paused. Job {} saved to DB but not pushed to Redis.", dbJob.getId());
      }
    } catch (Exception e) {
      log.error("Failed to push job {} to Redis", dbJob.getId(), e);
    }
  }

  public void pushJobToRedis(Job job) {
    try {
      String queueName = "queue:" + job.getType();
      redisTemplate
          .opsForList()
          .rightPush(Objects.requireNonNull(queueName), Objects.requireNonNull(job.getPayload()));
      // DEBUG: the jobs row carries type, id and status already, and Grafana reads queue depth from
      // there rather than by counting these lines.
      log.debug("Enqueued {} job {} onto {}", job.getType(), job.getId(), queueName);
    } catch (Exception e) {
      log.error("Failed to push job {} to Redis", job.getId(), e);
    }
  }

  public void requeuePendingJobs() {
    // Clear queues first to prevent duplication
    redisTemplate.delete(
        Objects.requireNonNull(
            List.of(
                "queue:panel-detection",
                "queue:ocr",
                "queue:layout",
                "queue:translation",
                "queue:render",
                "queue:qa",
                "queue:qa-re-ocr",
                "queue:region-redo-ocr",
                "queue:region-redo-tl")));

    List<Job> pendingJobs = jobRepository.findByStatusOrderByCreatedAtAsc("PENDING");
    log.info("Re-queuing {} PENDING jobs onto Redis queues", pendingJobs.size());
    for (Job job : pendingJobs) {
      pushJobToRedis(job);
    }
  }

  private String updatePayloadAttempt(String payload, int attempt) {
    if (payload == null)
      return null;
    try {
      Map<String, Object> payloadMap = objectMapper.readValue(
          payload, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {
          });
      payloadMap.put("attempt", attempt);
      return objectMapper.writeValueAsString(payloadMap);
    } catch (Exception e) {
      log.error("Failed to update payload attempt: {}", e.getMessage());
      return payload;
    }
  }

  /**
   * Whether a stored chapter/series value counts as a real override rather than a placeholder.
   *
   * <p>Anything that reads this must use the same predicate the pipeline uses, otherwise the UI can
   * report a different model from the one that actually runs — see SeriesController.toChapterDto.
   */
  public static boolean isOverride(String value) {
    if (value == null) {
      return false;
    }
    // AUDIT-Q3: trim once and compare against that. This used to trim for the emptiness check and
    // then compare the *untrimmed* value against the placeholders, so " inherit " was not empty,
    // was not equal to "inherit", and sailed through as a real model name.
    String trimmed = value.trim();
    return !trimmed.isEmpty()
        && !trimmed.equals("inherit")
        && !trimmed.equals("default")
        && !trimmed.contains("[ORPHANED]");
  }

  public String resolveModel(String chapterVal, String seriesVal, String globalVal) {
    if (isOverride(chapterVal))
      return chapterVal;
    if (isOverride(seriesVal))
      return seriesVal;
    return globalVal;
  }

  public String resolveModelWithCheck(
      String chapterVal, String seriesVal, String globalVal, String provider, String task) {
    String resolved = resolveModel(chapterVal, seriesVal, globalVal);
    if (!Objects.equals(resolved, globalVal)
        && providerConfigCache != null
        && provider != null
        && task != null
        && !providerConfigCache.isValidProviderModel(provider, resolved, task)) {
      log.warn(
          "Resolved model '{}' for task '{}' under provider '{}' is no longer valid or available — falling back to global default '{}'",
          resolved,
          task,
          provider,
          globalVal);
      return globalVal;
    }
    return resolved;
  }

  public ResolvedPipelineConfig resolveConfigForChapter(Chapter chapter) {
    Series series = chapter.getSeries();
    if (series == null) {
      series = new Series(); // Dummy series to avoid null checks
    }
    com.manga.library.dto.SystemSettingsDto settings = systemSettingsService.getSettings();

    String resolvedOcrProvider = resolveModel(
        chapter.getOcrProvider(), series.getOcrProvider(), settings.ocrProvider());
    String resolvedOcrModel = resolveModelWithCheck(
        chapter.getOcrModel(), series.getOcrModel(), settings.ocrModel(), resolvedOcrProvider, "ocr");

    if ("local".equals(resolvedOcrProvider)) {
      // Keep a chapter/series choice of local model (PP-OCRv6 vs PP-OCRv5) rather than collapsing
      // to the global default — this value feeds the duplicate-page comparison, so flattening it
      // made two differently-configured chapters look identical.
      resolvedOcrModel = resolveModelWithCheck(
          chapter.getOcrModel(),
          series.getOcrModel(),
          settings.localOcrModel(),
          resolvedOcrProvider,
          "ocr");
    }

    // The task keys must match providers.json, which uses tl / qaLLM / qaVLM / ocr — not the
    // pipeline stage names. Passing "translation" and "qa" made ProviderConfigCache.models.get(task)
    // return null, isValidProviderModel return false, and resolveModelWithCheck discard every
    // resolved value in favour of the global default (AUDIT-P1). The duplicate-page comparison in
    // PageController and SeriesController then compared global defaults against global defaults and
    // decided two differently-configured chapters were identical, so the clone path reused OCR/TL
    // data it should have regenerated. enqueueJobDirectly above already passes the correct keys.
    String resolvedTlProvider = resolveModel(
        chapter.getTlProvider(), series.getTlProvider(), settings.tlProvider());
    String resolvedTlModel = resolveModelWithCheck(
        chapter.getTlModel(), series.getTlModel(), settings.tlModel(), resolvedTlProvider, "tl");

    String resolvedQaProvider = resolveModel(
        chapter.getQaProvider(), series.getQaProvider(), settings.qaProvider());
    String resolvedQaLlmModel = resolveModelWithCheck(
        chapter.getQaLlmModel(), series.getQaLlmModel(), settings.qaLlmModel(), resolvedQaProvider, "qaLLM");
    String resolvedQaVlmModel = resolveModelWithCheck(
        chapter.getQaVlmModel(), series.getQaVlmModel(), settings.qaVlmModel(), resolvedQaProvider, "qaVLM");
    String resolvedQaMode = resolveModel(
        chapter.getQaMode(), series.getQaMode(), settings.qaMode());

    return new ResolvedPipelineConfig(
        resolvedOcrProvider, resolvedOcrModel,
        resolvedTlProvider, resolvedTlModel,
        resolvedQaProvider, resolvedQaLlmModel, resolvedQaVlmModel, resolvedQaMode
    );
  }

  private boolean hasUsableModel(String provider, String model, String task) {
    if (model == null || model.trim().isEmpty())
      return false;
    String m = model.trim();
    if (m.equalsIgnoreCase("N/A")
        || m.equals("inherit")
        || m.equals("default")
        || m.contains("[ORPHANED]"))
      return false;
    // ProviderConfigCache.isValidProviderModel returns true when its cache is empty
    // (permissive
    // pre-startup), which is fine here.
    return providerConfigCache == null
        || providerConfigCache.isValidProviderModel(provider, m, task);
  }

  /**
   * Claims the right to apply a result callback, returning false when this job's result has already
   * been written once (AUDIT-P4).
   *
   * <p>Two paths requeue a job without telling the worker to stop — {@link
   * #resetProcessingJobsToPending()} at every backend boot, and {@link
   * #recoverStaleProcessingJobs()} after ten minutes of silence, which is shorter than a slow
   * cloud-VLM OCR pass on a busy page. The worker is a separate container that does not restart with
   * the backend, so its in-flight work keeps running and the requeued copy runs alongside it. Both
   * eventually call back for the same job row. None of these handlers were idempotent, so the second
   * callback wrote a second full region set, a second layer, and double-counted cost: the drained
   * run of 2026-08-02 logged 277 dispatches for 255 jobs and produced 12 duplicate (subject, type)
   * rows, with one subject running translation, qa and render three times each.
   *
   * <p>A genuinely failed job never reaches its callback — the worker raises before posting — so it
   * leaves the claim unset and its retry is applied normally. Only a *second* result for work that
   * already landed is dropped.
   *
   * <p>The row is resolved by {@code jobId} when the callback carries one (AUDIT-P5). That matters
   * here specifically: the guard used to pick its row with the same "newest job of this type"
   * guess it exists to make safe, so claiming the wrong row both mis-marked that row *and* left
   * the real one unclaimed — freeing the genuine callback to apply twice, which is the exact
   * failure this guard was added to prevent. When no job row can be found there is nothing to
   * deduplicate against, so the callback is applied.
   */
  private boolean claimCallback(String jobId, UUID imageId, String jobType) {
    Job job = resolveCallbackJob(jobId, imageId, jobType);
    if (job == null) {
      return true;
    }
    OffsetDateTime now = OffsetDateTime.now();
    if (jobRepository.claimCallback(job.getId(), now) == 0) {
      log.warn(
          "Ignoring duplicate {} callback for image {} — job {} already applied its result at {}. "
              + "A recovery path requeued this job while the original worker was still running.",
          jobType,
          imageId,
          job.getId(),
          job.getCallbackAppliedAt());
      return false;
    }
    // The claim is a bulk UPDATE, which does not reach the copy of this row already in the
    // persistence context. Mirror it so a later save() of the same entity cannot write the old
    // null back over the claim.
    job.setCallbackAppliedAt(now);
    return true;
  }

  @Transactional
  public void handlePanelCallback(PanelCallbackDto dto) {
    UUID imageId = dto.imageId();
    log.info("Received panel callback for image: {} with {} panels", imageId, dto.panels().size());

    if (!claimCallback(dto.jobId(), imageId, "panel-detection")) {
      return;
    }

    Objects.requireNonNull(imageId, "imageId cannot be null");
    Image image = imageRepository
        .findById(Objects.requireNonNull(imageId))
        .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    Page page = resolvePageForCallback(imageId, dto.pageId());

    // Panels belong to the Image and are shared by every Page that reuses it. Replacing
    // them would orphan the panel_id of ocr_regions belonging to other chapters' pages
    // (a foreign key violation that aborts the whole callback), and detection is
    // deterministic for a given image anyway — so keep whatever is already there.
    List<Panel> existingPanels = panelRepository.findByImageId(imageId);
    if (existingPanels.isEmpty()) {
      List<Panel> panelsToSave = new ArrayList<>();
      for (PanelCallbackDto.PanelData pData : dto.panels()) {
        Panel panel = new Panel();
        panel.setImage(image);
        panel.setBboxX(pData.x());
        panel.setBboxY(pData.y());
        panel.setBboxW(pData.width());
        panel.setBboxH(pData.height());
        panel.setGridRow(pData.gridRow());
        panel.setGridCol(pData.gridCol());
        panel.setReadingOrder(pData.readingOrder());
        panelsToSave.add(panel);
      }
      panelRepository.saveAll(Objects.requireNonNull(panelsToSave));
    } else {
      log.info(
          "Image {} already has {} panels — reusing them instead of re-detecting",
          imageId,
          existingPanels.size());
    }

    // Trigger OCR
    enqueueJobForPage("ocr", imageId, page != null ? page.getId() : null);
  }

  @Transactional
  public void handleOcrCallback(OcrCallbackDto dto) {
    UUID imageId = dto.imageId();
    log.info("Received OCR callback for image: {} with {} regions", imageId, dto.regions().size());

    if (!claimCallback(dto.jobId(), imageId, "ocr")) {
      return;
    }

    Objects.requireNonNull(imageId, "imageId cannot be null");
    imageRepository
        .findById(Objects.requireNonNull(imageId))
        .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    if (dto.regions() == null || dto.regions().isEmpty()) {
      log.info("OCR found 0 regions for image {} — skipping downstream pipeline", imageId);
      Job job = resolveCallbackJob(dto.jobId(), imageId, "ocr");
      if (job != null) {
        job.setStatus("COMPLETED");
        job.setUpdatedAt(OffsetDateTime.now());
        jobRepository.save(job);
        sseService.emitEventForImage(imageId, "job_update", job);
      }
      return;
    }

    Page page = resolvePageForCallback(imageId, dto.pageId());

    // AUDIT-P9: the page can be deleted between enqueue and callback, and both ocr_regions.page_id
    // and layers.page_id are NOT NULL. Without this guard the null flows into region.setPage() and
    // ocrLayer.setPage() and the insert fails at commit, rolling back the entire OCR result — after
    // which the job sits PROCESSING until the stale sweeper requeues it and the whole expensive OCR
    // pass runs again, to fail identically, up to maxAttempts. Fail it once, here, with a reason.
    if (page == null) {
      log.warn("OCR callback for image {} has no page (deleted mid-pipeline?) — failing the job",
          imageId);
      failJob(
          dto.jobId(),
          imageId,
          "ocr",
          "Page no longer exists — it was deleted while OCR was running");
      return;
    }

    // Keep existing layers and regions for multi-pass history, but hide old OCR
    // layers
    List<Layer> existingLayers = layerRepository.findByPageId(page.getId());
    int maxZ = 0;
    for (Layer layer : existingLayers) {
      if (layer.getZOrder() > maxZ) {
        maxZ = layer.getZOrder();
      }
      if ("ocr".equalsIgnoreCase(layer.getType())) {
        layer.setVisible(false);
        layerRepository.save(Objects.requireNonNull(layer));
      }
    }
    int nextZOrder = maxZ + 1;

    // Fetch panels to map regions to panels
    List<Panel> panels = panelRepository.findByImageId(imageId);

    // Save OCR Regions
    List<OcrRegion> regionsToSave = new ArrayList<>();
    for (OcrCallbackDto.OcrRegionData rData : dto.regions()) {
      // Find which panel this OCR region resides in based on overlap
      Panel matchingPanel = findMatchingPanel(rData.x(), rData.y(), rData.width(), rData.height(), panels);

      OcrRegion region = new OcrRegion();
      region.setPage(page);
      region.setPanel(matchingPanel);
      region.setText(rData.text());
      region.setDetectedLanguage(rData.detectedLanguage());
      region.setConfidence(rData.confidence());
      region.setOcrScore(rData.confidence());
      region.setRotation(rData.rotation() != null ? rData.rotation() : 0.0);
      region.setBboxX(rData.x());
      region.setBboxY(rData.y());
      region.setBboxW(rData.width());
      region.setBboxH(rData.height());
      region.setPanelReadingOrder(matchingPanel != null ? matchingPanel.getReadingOrder() : 0);
      region.setBubbleReadingOrder(rData.bubbleReadingOrder());
      region.setBackgroundColor(rData.backgroundColor());
      region.setBubbleX(rData.bubbleX());
      region.setBubbleY(rData.bubbleY());
      region.setBubbleW(rData.bubbleWidth());
      region.setBubbleH(rData.bubbleHeight());
      region.setBubbleId(rData.bubbleId());
      region.setDetectionConfidence(rData.detectionConfidence());
      region.setMaskPolygon(rData.maskPolygon());
      region.setSafeTextX(rData.safeTextX());
      region.setSafeTextY(rData.safeTextY());
      region.setSafeTextW(rData.safeTextW());
      region.setSafeTextH(rData.safeTextH());
      regionsToSave.add(region);
    }
    List<OcrRegion> savedRegions = ocrRegionRepository.saveAll(Objects.requireNonNull(regionsToSave));

    // Create default OCR overlay layer
    com.fasterxml.jackson.databind.node.ObjectNode metadata = objectMapper.createObjectNode();
    metadata.put("provider", "OCR Worker");
    metadata.put("model", dto.modelIdentifier() != null ? dto.modelIdentifier() : "unknown");
    metadata.put("time", OffsetDateTime.now().toString());
    metadata.put("confidence", dto.confidence() != null ? dto.confidence() : 1.0);

    String ocrReason = redisTemplate.opsForValue().get("image:ocr:reason:" + imageId);
    if (ocrReason != null) {
      metadata.put("layer_name", "OCR (" + ocrReason + ")");
      redisTemplate.delete(Objects.requireNonNull("image:ocr:reason:" + imageId));
    } else {
      metadata.put("layer_name", "OCR");
    }

    if (dto.cost() != null) {
      metadata.set("cost", objectMapper.valueToTree(dto.cost()));
      if (dto.cost() instanceof Map<?, ?> cost) {
        saveJobCosts(imageId, stringKeyedMap(cost));
      }
    }

    metadata.put("layer_order", nextZOrder);
    metadata.put("last_modified", OffsetDateTime.now().toString());

    Layer ocrLayer = new Layer();
    ocrLayer.setPage(page);
    ocrLayer.setType("ocr");
    ocrLayer.setVisible(true);
    ocrLayer.setZOrder(nextZOrder);
    ocrLayer.setMetadataJson(metadata);

    Objects.requireNonNull(ocrLayer, "ocrLayer cannot be null");
    layerRepository.save(Objects.requireNonNull(ocrLayer));

    List<LayerElement> elementsToSave = new ArrayList<>();
    for (OcrRegion region : savedRegions) {
      LayerElement element = new LayerElement();
      element.setLayer(ocrLayer);
      element.setRegion(region);
      element.setText(region.getText());
      element.setX(region.getBboxX().doubleValue());
      element.setY(region.getBboxY().doubleValue());
      element.setMaxWidth(region.getBboxW());
      element.setMaxHeight(region.getBboxH());
      element.setVisible(true);
      elementsToSave.add(element);
    }
    layerElementRepository.saveAll(Objects.requireNonNull(elementsToSave));

    // Trigger Layout analysis
    enqueueJobForPage("layout", imageId, page.getId());
  }

  @Transactional
  public void handleLayoutCallback(
      UUID imageId,
      List<Map<String, String>> regionTypes,
      List<Map<String, Object>> conversations) {
    handleLayoutCallback(imageId, null, regionTypes, conversations);
  }

  @Transactional
  public void handleLayoutCallback(
      UUID imageId,
      UUID callbackPageId,
      List<Map<String, String>> regionTypes,
      List<Map<String, Object>> conversations) {
    handleLayoutCallback(null, imageId, callbackPageId, regionTypes, conversations);
  }

  @Transactional
  public void handleLayoutCallback(
      String jobId,
      UUID imageId,
      UUID callbackPageId,
      List<Map<String, String>> regionTypes,
      List<Map<String, Object>> conversations) {
    log.info(
        "Received Layout callback for image: {} with {} regionTypes, {} conversations",
        imageId,
        regionTypes != null ? regionTypes.size() : 0,
        conversations != null ? conversations.size() : 0);

    if (!claimCallback(jobId, imageId, "layout")) {
      return;
    }

    Objects.requireNonNull(imageId, "imageId cannot be null");
    imageRepository
        .findById(Objects.requireNonNull(imageId))
        .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    // 1. Update region_type on each OcrRegion
    if (regionTypes != null) {
      for (Map<String, String> rt : regionTypes) {
        try {
          UUID regionId = UUID.fromString(rt.get("regionId"));
          String regionType = rt.get("regionType");
          Objects.requireNonNull(regionId, "regionId cannot be null");
          ocrRegionRepository
              .findById(Objects.requireNonNull(regionId))
              .ifPresent(
                  region -> {
                    region.setRegionType(regionType != null ? regionType : "speech");
                    ocrRegionRepository.save(Objects.requireNonNull(region));
                  });
        } catch (Exception e) {
          log.error("Error updating region type", e);
        }
      }
    }

    // 2. Do not delete old conversations to preserve multi-pass history

    // AUDIT-Q3: resolved once. This was called per conversation inside the loop below and then a
    // third time at the enqueue step, all with the same two arguments — a findById (or a
    // findByImageId) per conversation, for an answer that cannot change within the callback.
    Page callbackPage = resolvePageForCallback(imageId, callbackPageId);

    // 3. Create new Conversation + ConversationRegion entries
    if (conversations != null) {
      for (Map<String, Object> convData : conversations) {
        try {
          String sceneType = (String) convData.getOrDefault("sceneType", "dialogue");
          List<?> rawRegionIds = (List<?>) convData.get("regionIds");
          List<String> regionIds = new ArrayList<>();
          if (rawRegionIds != null) {
            for (Object rid : rawRegionIds) {
              if (rid instanceof String) {
                regionIds.add((String) rid);
              }
            }
          }

          Conversation conv = new Conversation();
          conv.setPage(callbackPage);
          conv.setSceneType(sceneType != null ? sceneType : "dialogue");

          Objects.requireNonNull(conv, "conv cannot be null");
          conv = conversationRepository.save(Objects.requireNonNull(conv));

          if (regionIds != null) {
            int position = 1;
            for (String ridStr : regionIds) {
              ConversationRegion cr = new ConversationRegion();
              cr.setConversationId(conv.getId());
              cr.setRegionId(UUID.fromString(ridStr));
              cr.setPosition(position++);
              Objects.requireNonNull(cr, "cr cannot be null");
              conversationRegionRepository.save(Objects.requireNonNull(cr));
            }
          }
        } catch (Exception e) {
          log.error("Error creating conversation", e);
        }
      }
    }

    // 4. Enqueue translation job
    boolean isReaderMode = false;
    Page layoutPage = callbackPage;
    Series series = layoutPage != null && layoutPage.getChapter() != null
        ? layoutPage.getChapter().getSeries()
        : null;
    if (series != null
        && series.getSourceLanguage() != null
        && series.getTargetLanguage() != null) {
      isReaderMode = series.getSourceLanguage().trim().equalsIgnoreCase(series.getTargetLanguage().trim());
    }

    if (isReaderMode && series != null) {
      log.info(
          "Reader mode detected (source=target={}) for image {}. Skipping translation, render, and QA.",
          series.getSourceLanguage(),
          imageId);
      // AUDIT-B8: this branch is the end of the pipeline, so nothing downstream will ever mark the
      // layout job terminal. It used to return with the row still PROCESSING and lean entirely on
      // the worker's PATCH — which AUDIT-P6 showed can be lost, after which
      // recoverStaleProcessingJobs requeues the layout pass ten minutes later for a chapter that
      // is already finished. Same shape as the empty-OCR branch above.
      Job layoutJob = resolveCallbackJob(jobId, imageId, "layout");
      if (layoutJob != null) {
        layoutJob.setStatus("COMPLETED");
        layoutJob.setUpdatedAt(OffsetDateTime.now());
        jobRepository.save(layoutJob);
        sseService.emitEventForImage(imageId, "job_update", layoutJob);
      }
      return;
    }

    enqueueJobForPage("translation", imageId, layoutPage != null ? layoutPage.getId() : null);
  }

  /** Where translated text is laid out, in original image pixels. */
  record TextBox(double x, double y, int w, int h) {}

  /** Inset from the bubble edge, each side. */
  private static final int TEXT_BOX_PADDING = 20;

  /** Below this, insetting would leave nothing to draw into, so the bubble is used as-is. */
  private static final int MIN_TEXT_BOX = 24;

  /** Outward growth per axis for free-floating text, which has no outline to stay inside. */
  private static final int FREE_TEXT_PADDING = 20;

  /** Only reshape a free-floating box this much taller than wide — a vertical Japanese column. */
  private static final double FREE_TEXT_COLUMN_ASPECT = 1.5;

  /** Width:height a reshaped free-floating box aims for. */
  private static final double FREE_TEXT_TARGET_ASPECT = 1.0;

  /** Ceiling on the reshape, as a multiple of the width the source text occupied. */
  private static final double FREE_TEXT_MAX_WIDEN = 2.5;

  /**
   * True when {@code bubble*} describes a container the text sits inside, rather than the text.
   *
   * <p>The worker populates bubble geometry on every region, but when nothing was matched to a text
   * fragment it fills {@code bubble*} from the OCR bbox itself (see {@code
   * worker/src/worker/handlers/ocr.py}). Over this library that was <b>1,832 of 4,351 translated
   * regions (42%)</b> — free-floating dialogue, captions, SFX — and on every one of them {@code
   * bubble == bbox == safeText} exactly.
   *
   * <p>The test is deliberately on the geometry rather than on {@code bubbleId}. Those regions are
   * tagged {@code direct_text_*}, but the tag means "YOLO matched no bubble", which is no longer the
   * same thing as "has no bubble": the worker's contour fallback can supply a real container for a
   * {@code direct_text_*} region, and that geometry must be inset like any other bubble. Geometry
   * strictly larger than the bbox is the property that actually matters, and it also catches rows
   * written before {@code bubbleId} existed.
   */
  private static boolean hasDetectedBubble(OcrRegion region) {
    if (region.getBubbleW() == null || region.getBubbleH() == null) {
      return false;
    }
    return !(region.getBubbleW().equals(region.getBboxW())
        && region.getBubbleH().equals(region.getBboxH()));
  }

  /**
   * Text box for a region. Inset into the bubble when there is one, grown outward when there is not.
   *
   * <p><b>With a detected bubble the box is inset.</b> The geometry before f3aa160 took {@code
   * safeText*} and grew it by 20px per axis. Measured over regions that have a real bubble, {@code
   * safeText} is <b>95.7% of bubble width and 97.4% of bubble height</b> — it is the bubble, not an
   * inset safe area — so growing it produced a text box <em>larger</em> than the bubble and let text
   * escape the outline. The box also takes the bubble's own extent rather than {@code safeText}'s,
   * because {@code safeText} traces vertically-set Japanese and laying English into that shape wraps
   * it into narrow ragged columns.
   *
   * <p><b>Without one the box is reshaped.</b> f3aa160 applied the inset unconditionally, but these
   * regions have no outline to stay inside and their geometry is already the tight text column —
   * insetting a 49px-wide caption to 29px is narrower than a single word at any legible size. Such a
   * box is grown outward and then squared up by {@link #freeTextBox}, because a 69px column still
   * forces one word per line where a human typesetter reflows the sentence across the cloud.
   */
  static TextBox textBoxFor(OcrRegion region) {
    boolean detectedBubble = hasDetectedBubble(region);

    Integer w = region.getBubbleW() != null ? region.getBubbleW() : region.getSafeTextW();
    Integer h = region.getBubbleH() != null ? region.getBubbleH() : region.getSafeTextH();
    Integer x = region.getBubbleW() != null ? region.getBubbleX() : region.getSafeTextX();
    Integer y = region.getBubbleH() != null ? region.getBubbleY() : region.getSafeTextY();

    if (w == null || h == null || x == null || y == null) {
      x = region.getBboxX();
      y = region.getBboxY();
      w = region.getBboxW();
      h = region.getBboxH();
    }

    if (!detectedBubble) {
      int halfPad = FREE_TEXT_PADDING / 2;
      return freeTextBox(
          x - halfPad, y - halfPad, w + FREE_TEXT_PADDING, h + FREE_TEXT_PADDING, pageBounds(region));
    }

    // Only inset when there is room to; a tiny bubble keeps its full extent rather than collapsing.
    boolean insetW = w > MIN_TEXT_BOX + TEXT_BOX_PADDING;
    boolean insetH = h > MIN_TEXT_BOX + TEXT_BOX_PADDING;
    int halfPad = TEXT_BOX_PADDING / 2;

    return new TextBox(
        Math.max(0, x + (insetW ? halfPad : 0)),
        Math.max(0, y + (insetH ? halfPad : 0)),
        insetW ? w - TEXT_BOX_PADDING : w,
        insetH ? h - TEXT_BOX_PADDING : h);
  }

  /**
   * Reshape a free-floating text box from the column the source text occupied into something English
   * can be set in.
   *
   * <p>Japanese here is set vertically, so a caption's geometry is a ~50px-wide, ~500px-tall ribbon
   * of ink. It is the shape of the writing, not of anything on the page — the cloud around it is
   * several times wider — and laying English into it gives one word per line at a size that has to
   * keep shrinking to fit the longest word. So the box keeps its area and its centre and squares up:
   * same amount of room, in a shape a sentence can reflow across.
   *
   * <p>Area is the conservative choice available without knowing where the artwork is. The rendered
   * text is centred in the box, so what actually lands on the page is the block of lines, not the
   * box; keeping the area equal keeps that block about as big as the source text it replaces, and
   * anchoring on the centre keeps it over the same spot. {@link #FREE_TEXT_MAX_WIDEN} bounds how far
   * a very thin column can push sideways, and the page bounds stop it running off the paper.
   *
   * <p>Boxes that are not columns — {@code narration}, which is set horizontally and measures 0.23
   * tall per wide — are left alone.
   *
   * @param page {@code {width, height}} of the page in pixels, or null when it is not known
   */
  private static TextBox freeTextBox(double x, double y, int w, int h, int[] page) {
    if (w <= 0 || h < w * FREE_TEXT_COLUMN_ASPECT) {
      return new TextBox(Math.max(0, x), Math.max(0, y), w, h);
    }

    double area = (double) w * h;
    int newW = (int) Math.round(Math.min(Math.sqrt(area * FREE_TEXT_TARGET_ASPECT), w * FREE_TEXT_MAX_WIDEN));
    newW = Math.max(newW, w);
    int newH = Math.max(MIN_TEXT_BOX, (int) Math.round(area / newW));

    double nx = x + w / 2.0 - newW / 2.0;
    double ny = y + h / 2.0 - newH / 2.0;
    if (page != null) {
      nx = Math.min(Math.max(0, nx), Math.max(0, page[0] - newW));
      ny = Math.min(Math.max(0, ny), Math.max(0, page[1] - newH));
    } else {
      nx = Math.max(0, nx);
      ny = Math.max(0, ny);
    }
    return new TextBox(nx, ny, newW, newH);
  }

  /** Page dimensions in pixels, or null when the region is detached or the image never recorded them. */
  private static int[] pageBounds(OcrRegion region) {
    try {
      Page page = region.getPage();
      Image image = page != null ? page.getImage() : null;
      if (image != null && image.getWidth() != null && image.getHeight() != null) {
        return new int[] {image.getWidth(), image.getHeight()};
      }
    } catch (RuntimeException e) {
      // A detached region cannot resolve its page. Reshaping without bounds is still better than not
      // reshaping; the box just is not clamped to the paper.
      log.debug("No page bounds for region {}: {}", region.getId(), e.toString());
    }
    return null;
  }

  @Transactional
  public void handleTranslationCallback(
      UUID imageId, List<Map<String, Object>> translations, Map<String, Object> cost) {
    handleTranslationCallback(null, imageId, translations, cost);
  }

  @Transactional
  public void handleTranslationCallback(
      String jobId,
      UUID imageId,
      List<Map<String, Object>> translations,
      Map<String, Object> cost) {
    log.info(
        "Received Translation callback for image: {} with {} translations",
        imageId,
        translations != null ? translations.size() : 0);

    if (!claimCallback(jobId, imageId, "translation")) {
      return;
    }

    Objects.requireNonNull(imageId, "imageId cannot be null");
    imageRepository
        .findById(Objects.requireNonNull(imageId))
        .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    UUID tlPageId = (translations != null && !translations.isEmpty())
        ? extractUuid(translations.get(0), "pageId")
        : null;
    Page page = resolvePageForCallback(imageId, tlPageId);
    Series series = page != null && page.getChapter() != null ? page.getChapter().getSeries() : null;
    String targetLang = (series != null && series.getTargetLanguage() != null)
        ? series.getTargetLanguage().trim().toLowerCase()
        : "en";

    long successCount = translations == null
        ? 0
        : translations.stream()
            .filter(
                r -> {
                  Object failedObj = r.get("translationFailed");
                  boolean failed = failedObj != null && Boolean.parseBoolean(failedObj.toString());
                  return !failed;
                })
            .count();

    if (successCount == 0) {
      log.warn("All translations failed for image {} — not creating empty layer", imageId);
      Job job = resolveCallbackJob(jobId, imageId, "translation");
      if (job != null) {
        job.setStatus("FAILED");
        job.setError("Translation failed: no regions were successfully translated");
        job.setUpdatedAt(OffsetDateTime.now());
        jobRepository.save(job);
        sseService.emitEventForImage(imageId, "job_update", job);
      }
      return;
    }

    // Find existing translation layers for this image and language
    final String finalTargetLang = targetLang;
    List<Layer> existingTranslationLayers = new ArrayList<>();
    List<Layer> allLayers = page != null ? layerRepository.findByPageId(page.getId()) : List.of();
    for (Layer l : allLayers) {
      if ("translation".equalsIgnoreCase(l.getType())
          && finalTargetLang.equalsIgnoreCase(l.getTargetLanguage())) {
        existingTranslationLayers.add(l);
      }
    }

    boolean isRedo = !existingTranslationLayers.isEmpty();
    if (isRedo) {
      // Hide old translation layers
      for (Layer old : existingTranslationLayers) {
        old.setVisible(false);
        layerRepository.save(Objects.requireNonNull(old));
      }
    }

    // Compute z-order from ALL layers (not just translation), so it's always at the
    // top
    int maxZ = 0;
    for (Layer l : allLayers) {
      if (l.getZOrder() > maxZ) {
        maxZ = l.getZOrder();
      }
    }
    int nextZOrder = maxZ + 1;

    com.fasterxml.jackson.databind.node.ObjectNode metadata = objectMapper.createObjectNode();
    String modelIdentifier = "unknown";
    Double avgConfidence = 1.0;
    if (translations != null && !translations.isEmpty()) {
      if (translations.get(0).containsKey("modelIdentifier")) {
        modelIdentifier = (String) translations.get(0).get("modelIdentifier");
      }
      if (translations.get(0).containsKey("confidence")) {
        Object confObj = translations.get(0).get("confidence");
        if (confObj instanceof Number) {
          avgConfidence = ((Number) confObj).doubleValue();
        }
      }
    }
    String provider = "Translation Worker";
    String model = modelIdentifier;
    if (modelIdentifier.contains("/")) {
      int slashIdx = modelIdentifier.indexOf('/');
      provider = modelIdentifier.substring(0, slashIdx);
      model = modelIdentifier.substring(slashIdx + 1);
    }

    metadata.put("provider", provider);
    metadata.put("model", model);
    metadata.put("time", OffsetDateTime.now().toString());
    metadata.put("confidence", avgConfidence);

    String transReason = redisTemplate.opsForValue().get("image:translation:reason:" + imageId);
    if (transReason != null) {
      metadata.put("layer_name", "Translation (" + transReason + ")");
      redisTemplate.delete("image:translation:reason:" + imageId);
    } else if (isRedo) {
      metadata.put("layer_name", "Translation (retry)");
    } else {
      metadata.put("layer_name", "Translation");
    }

    metadata.put("layer_order", nextZOrder);
    metadata.put("last_modified", OffsetDateTime.now().toString());

    if (cost != null) {
      com.fasterxml.jackson.databind.node.ObjectNode tlNode = objectMapper.createObjectNode();
      tlNode.set("cost", objectMapper.valueToTree(cost));
      metadata.set("tl", tlNode);
      saveJobCosts(imageId, cost);
    }

    Layer translationLayer = new Layer();
    translationLayer.setPage(page);
    translationLayer.setType("translation");
    translationLayer.setTargetLanguage(finalTargetLang);
    translationLayer.setVisible(true);
    translationLayer.setZOrder(nextZOrder);
    translationLayer.setMetadataJson(metadata);
    translationLayer = layerRepository.save(Objects.requireNonNull(translationLayer));
    final Layer finalLayer = translationLayer;

    if (translations != null) {
      // Find all existing elements for this layer
      List<LayerElement> existingElements = layerElementRepository.findByLayerId(translationLayer.getId());
      Map<UUID, LayerElement> elementMap = new HashMap<>();
      for (LayerElement el : existingElements) {
        if (el.getRegion() != null) {
          elementMap.put(el.getRegion().getId(), el);
        }
      }

      for (Map<String, Object> t : translations) {
        try {
          UUID regionId = UUID.fromString((String) t.get("regionId"));
          String translatedText = (String) t.get("translatedText");
          Object failedVal = t.get("translationFailed");
          boolean translationFailed = failedVal != null && Boolean.parseBoolean(failedVal.toString());

          Double translationScore = t.get("translationScore") != null
              ? ((Number) t.get("translationScore")).doubleValue()
              : null;

          Objects.requireNonNull(regionId, "regionId cannot be null");
          ocrRegionRepository
              .findById(Objects.requireNonNull(regionId))
              .ifPresent(
                  region -> {
                    // Update backward-compatible OcrRegion fields
                    region.setTranslatedText(translatedText);
                    region.setTranslationFailed(translationFailed);
                    region.setTranslationScore(translationScore);
                    ocrRegionRepository.save(Objects.requireNonNull(region));

                    // Find or create LayerElement
                    LayerElement element = elementMap.get(regionId);
                    if (element == null) {
                      TextBox box = textBoxFor(region);
                      double ex = box.x();
                      double ey = box.y();
                      int ew = box.w();
                      int eh = box.h();

                      element = new LayerElement();
                      element.setLayer(finalLayer);
                      element.setRegion(region);
                      element.setText(translatedText);
                      element.setX(ex);
                      element.setY(ey);
                      element.setMaxWidth(ew);
                      element.setMaxHeight(eh);
                      element.setVisible(true);
                      element.setAutoSize(true);
                      element.setFont("Comic Neue");
                      element.setFontWeight("bold");
                      element.setBackgroundColor(region.getBackgroundColor());
                      element.setTextColor(getContrastingTextColor(region.getBackgroundColor()));
                      element.setBoxShape(
                          "speech".equalsIgnoreCase(region.getRegionType())
                              ? "elliptical"
                              : "rectangular");
                      element.setMaskPolygon(region.getMaskPolygon());
                    } else {
                      element.setText(translatedText);
                      if (!Boolean.TRUE.equals(element.getIsManuallyEdited())) {
                        TextBox box = textBoxFor(region);
                        element.setX(box.x());
                        element.setY(box.y());
                        element.setMaxWidth(box.w());
                        element.setMaxHeight(box.h());
                        element.setMaskPolygon(region.getMaskPolygon());
                      }
                    }
                    Objects.requireNonNull(element, "element cannot be null");
                    layerElementRepository.save(Objects.requireNonNull(element));
                  });
        } catch (Exception e) {
          log.error("Error saving translation for region", e);
        }
      }
    }

    enqueueJobForPage("render", imageId, page != null ? page.getId() : null);
  }

  @Transactional
  public void triggerRedo(UUID regionId, String redoType) {
    log.info("Triggering redo for region {} with type {}", regionId, redoType);

    Objects.requireNonNull(regionId, "regionId cannot be null");
    OcrRegion region = ocrRegionRepository
        .findById(Objects.requireNonNull(regionId))
        .orElseThrow(() -> new IllegalArgumentException("Region not found: " + regionId));

    Page page = region.getPage();
    UUID imageId = page != null ? page.getImage().getId() : null;
    UUID pageId = page != null ? page.getId() : null;

    String jobType = "ocr".equalsIgnoreCase(redoType) ? "region-redo-ocr" : "region-redo-tl";

    enqueueJobForPage(
        jobType,
        imageId,
        pageId,
        "high",
        job -> {
          job.put("regionId", regionId.toString());
          job.put("redoType", redoType);
        });
  }

  @Transactional
  public void triggerPageRedo(UUID pageId, String jobType) {
    triggerPageRedo(pageId, jobType, null);
  }

  @Transactional
  public void triggerPageRedo(UUID pageId, String jobType, UUID chapterId) {
    log.info(
        "Triggering page redo for page {} with job type {} and chapter {}",
        pageId,
        jobType,
        chapterId);
    Objects.requireNonNull(pageId, "pageId cannot be null");
    Page page = pageRepository
        .findById(Objects.requireNonNull(pageId))
        .orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));
    UUID imageId = page.getImage().getId();
    // AUDIT-P7: both of these were keyed by pageId, and nothing anywhere reads a page-scoped key.
    // The reason consumers (:927, :1368) read image:{ocr,translation}:reason:{imageId}, so a page
    // redo never got its "(manual-re-ocr)" layer label and the keys accumulated in Redis unread;
    // and trace keys are written under imageId (:246, :303, :309), so the delete was a no-op and
    // the redo inherited the previous run's trace id. triggerImageRedo already did both correctly.
    if ("ocr".equals(jobType)) {
      redisTemplate.opsForValue().set("image:ocr:reason:" + imageId, "manual-re-ocr", REDO_REASON_TTL);
    } else if ("translation".equals(jobType)) {
      redisTemplate
          .opsForValue()
          .set("image:translation:reason:" + imageId, "manual-re-translate", REDO_REASON_TTL);
    }

    if (redisTemplate != null) {
      redisTemplate.delete("pipeline:trace:" + imageId);
    }

    UUID chapterFromPage = page.getChapter() != null ? page.getChapter().getId() : null;
    UUID effectiveChapterId = chapterId != null ? chapterId : chapterFromPage;

    enqueueJobDirectly(jobType, imageId, pageId, effectiveChapterId, "normal", job -> {
    });
  }

  @Transactional
  public void triggerImageRedo(UUID imageId, String jobType) {
    triggerImageRedo(imageId, jobType, null);
  }

  @Transactional
  public void triggerImageRedo(UUID imageId, String jobType, UUID chapterId) {
    log.info(
        "Triggering image redo for image {} with job type {} and chapter {}",
        imageId,
        jobType,
        chapterId);
    if ("ocr".equals(jobType)) {
      redisTemplate.opsForValue().set("image:ocr:reason:" + imageId, "manual-re-ocr", REDO_REASON_TTL);
    } else if ("translation".equals(jobType)) {
      redisTemplate
          .opsForValue()
          .set("image:translation:reason:" + imageId, "manual-re-translate", REDO_REASON_TTL);
    }

    // Clear the traceId so a fresh one is generated for the new pipeline run
    if (redisTemplate != null) {
      redisTemplate.delete("pipeline:trace:" + imageId);
    }

    enqueueJob(jobType, imageId, chapterId);
  }

  @Transactional
  public void handleQaReOcrCallback(UUID imageId, List<Map<String, Object>> results) {
    handleQaReOcrCallback(imageId, null, results);
  }

  @Transactional
  public void handleQaReOcrCallback(
      UUID imageId, UUID callbackPageId, List<Map<String, Object>> results) {
    handleQaReOcrCallback(null, imageId, callbackPageId, results);
  }

  @Transactional
  public void handleQaReOcrCallback(
      String jobId, UUID imageId, UUID callbackPageId, List<Map<String, Object>> results) {
    log.info(
        "Received QA Re-OCR callback for image: {} with {} results",
        imageId,
        results != null ? results.size() : 0);
    Objects.requireNonNull(imageId, "imageId cannot be null");

    if (!claimCallback(jobId, imageId, "qa-re-ocr")) {
      return;
    }

    if (results != null) {
      for (Map<String, Object> r : results) {
        try {
          UUID regionId = UUID.fromString((String) r.get("regionId"));
          String text = (String) r.get("text");
          Double confidence = r.get("confidence") != null ? ((Number) r.get("confidence")).doubleValue() : null;
          String detectedLanguage = (String) r.get("detectedLanguage");

          ocrRegionRepository
              .findById(Objects.requireNonNull(regionId))
              .ifPresent(
                  region -> {
                    region.setText(text);
                    region.setConfidence(confidence);
                    region.setDetectedLanguage(detectedLanguage);
                    region.setQaStatus("re_ocr_completed");
                    ocrRegionRepository.save(Objects.requireNonNull(region));
                  });
        } catch (Exception e) {
          log.error("Error processing QA Re-OCR result for region", e);
        }
      }
    }

    // Now proceed to retry translation with the new OCR text
    log.info("QA Re-OCR complete for image {}. Enqueuing translation job...", imageId);
    Page reOcrPage = resolvePageForCallback(imageId, callbackPageId);
    redisTemplate
        .opsForValue()
        .set("image:translation:reason:" + imageId, "qa-re-ocr", REDO_REASON_TTL);
    enqueueJobForPage("translation", imageId, reOcrPage != null ? reOcrPage.getId() : null);
  }

  @Transactional
  public void handleRenderCallback(UUID imageId) {
    handleRenderCallback(imageId, null);
  }

  @Transactional
  public void handleRenderCallback(UUID imageId, UUID pageId) {
    handleRenderCallback(null, imageId, pageId);
  }

  @Transactional
  public void handleRenderCallback(String jobId, UUID imageId, UUID pageId) {
    if (!claimCallback(jobId, imageId, "render")) {
      return;
    }
    List<Page> pages = pageId != null
        ? pageRepository.findById(pageId).map(List::of).orElse(List.of())
        : pageRepository.findByImageId(imageId);
    for (Page page : pages) {
      page.setLastRenderedAt(OffsetDateTime.now());
      pageRepository.save(page);
    }
    boolean manualChangesDone = false;
    for (Page page : pages) {
      List<LayerElement> elements = layerElementRepository.findByLayerPageId(page.getId());
      if (elements != null) {
        for (LayerElement el : elements) {
          if (Boolean.TRUE.equals(el.getIsManuallyEdited())) {
            manualChangesDone = true;
            break;
          }
        }
      }
    }

    if (manualChangesDone) {
      log.info(
          "Received Render callback for image: {}. Skipping QA as manual edits exist.", imageId);
      if (redisTemplate != null) {
        redisTemplate.delete("pipeline:trace:" + imageId);
      }
    } else {
      log.info("Received Render callback for image: {}. Enqueuing QA job...", imageId);
      UUID qaPageId = pageId != null
          ? pageId
          : pages.stream().findFirst().map(Page::getId).orElse(null);
      String retryKey = qaRetryKey(imageId, qaPageId);
      String retryValStr = redisTemplate.opsForValue().get(retryKey);
      int retries = retryValStr != null ? Integer.parseInt(retryValStr) : 0;
      enqueueJobForPage(
          "qa", imageId, qaPageId, "normal", job -> job.put("qaPass", retries + 1));
    }
  }

  /**
   * QA retries are counted per page, not per image: two chapters can be running their own QA passes
   * over the same duplicated image and must not consume each other's retry budget.
   */
  private String qaRetryKey(UUID imageId, UUID pageId) {
    return pageId != null ? "page:qa:retries:" + pageId : "image:qa:retries:" + imageId;
  }

  @Transactional
  public void prepareHybridQa(UUID imageId, List<Map<String, Object>> qaResults) {
    prepareHybridQa(imageId, null, qaResults);
  }

  @Transactional
  public void prepareHybridQa(
      UUID imageId, UUID callbackPageId, List<Map<String, Object>> qaResults) {
    log.info(
        "Preparing hybrid QA for image: {} with {} LLM first pass results",
        imageId,
        qaResults != null ? qaResults.size() : 0);
    Objects.requireNonNull(imageId, "imageId cannot be null");

    // Find the latest translation layer
    Page hybridPage = resolvePageForCallback(imageId, callbackPageId);
    List<Layer> layers = hybridPage != null ? layerRepository.findByPageId(hybridPage.getId()) : List.of();
    Layer latestTranslationLayer = null;
    for (Layer l : layers) {

      if ("translation".equalsIgnoreCase(l.getType())
          && (latestTranslationLayer == null
              || l.getZOrder() > latestTranslationLayer.getZOrder())) {
        latestTranslationLayer = l;
      }
    }

    final Layer finalLatestTranslationLayer = latestTranslationLayer;

    if (qaResults != null) {
      for (Map<String, Object> r : qaResults) {
        try {
          UUID regionId = UUID.fromString((String) r.get("regionId"));
          String qaStatus = (String) r.get("qaStatus");
          Double qaScore = r.get("qaScore") != null ? ((Number) r.get("qaScore")).doubleValue() : null;
          String qaFeedback = (String) r.get("qaFeedback");

          ocrRegionRepository
              .findById(Objects.requireNonNull(regionId))
              .ifPresent(
                  region -> {
                    region.setQaStatus(qaStatus);
                    region.setQaScore(qaScore);
                    region.setQaFeedback(qaFeedback);

                    if ("direct_fix".equalsIgnoreCase(qaStatus) && r.containsKey("directFix")) {
                      Map<?, ?> directFix = (Map<?, ?>) r.get("directFix");
                      List<LayerElement> elements = layerElementRepository.findByRegionId(regionId);
                      for (LayerElement el : elements) {
                        if (el.getLayer() != null
                            && "translation".equalsIgnoreCase(el.getLayer().getType())
                            && finalLatestTranslationLayer != null
                            && el.getLayer().getId().equals(finalLatestTranslationLayer.getId())) {
                          if (directFix.containsKey("correctedText")) {
                            el.setText((String) directFix.get("correctedText"));
                            region.setTranslatedText((String) directFix.get("correctedText"));
                          }
                          if (directFix.containsKey("suggestedFontSize")) {
                            el.setSize(((Number) directFix.get("suggestedFontSize")).doubleValue());
                          }
                          layerElementRepository.save(Objects.requireNonNull(el));
                        }
                      }
                      region.setQaStatus("fixed");
                    } else if ("reject_sfx".equalsIgnoreCase(qaStatus)) {
                      hideTranslationElements(regionId, finalLatestTranslationLayer);
                    }
                    ocrRegionRepository.save(Objects.requireNonNull(region));
                  });
        } catch (Exception e) {
          log.error("Error processing LLM QA hybrid preparation result for region", e);
        }
      }
    }

    // Set correct layer visibility: latest translation visible, others invisible.
    // OCR invisible.
    for (Layer l : layers) {
      boolean shouldBeVisible;
      if ("translation".equalsIgnoreCase(l.getType())) {
        shouldBeVisible = (latestTranslationLayer != null && l.getId().equals(latestTranslationLayer.getId()));
      } else if ("ocr".equalsIgnoreCase(l.getType())) {
        shouldBeVisible = false;
      } else if ("sfx".equalsIgnoreCase(l.getType())) {
        shouldBeVisible = true;
      } else {
        shouldBeVisible = l.getVisible() == null || l.getVisible();
      }

      if (l.getVisible() == null || l.getVisible() != shouldBeVisible) {
        l.setVisible(shouldBeVisible);
        layerRepository.save(Objects.requireNonNull(l));
      }
    }
  }

  @Transactional
  public String handleQaCallback(
      UUID imageId, List<Map<String, Object>> qaResults, Map<String, Object> cost) {
    return handleQaCallback(imageId, null, qaResults, cost);
  }

  @Transactional
  public String handleQaCallback(
      UUID imageId,
      UUID callbackPageId,
      List<Map<String, Object>> qaResults,
      Map<String, Object> cost) {
    return handleQaCallback(null, imageId, callbackPageId, qaResults, cost);
  }

  @Transactional
  public String handleQaCallback(
      String jobId,
      UUID imageId,
      UUID callbackPageId,
      List<Map<String, Object>> qaResults,
      Map<String, Object> cost) {
    log.info(
        "Received QA callback for image: {} with {} results",
        imageId,
        qaResults != null ? qaResults.size() : 0);
    Objects.requireNonNull(imageId, "imageId cannot be null");

    if (!claimCallback(jobId, imageId, "qa")) {
      return "DUPLICATE";
    }

    boolean needsRetry = false;
    boolean needsManualIntervention = false;
    List<String> regionsToReOcr = new ArrayList<>();

    final List<Map<String, Object>> failedRegionsList = new ArrayList<>();
    final int[] stats = new int[5]; // 0: total, 1: passed, 2: failed, 3: direct_fix/fixed, 4: manual_review
    final double[] scoreStats = new double[2]; // 0: sum, 1: count
    int discardedResults = 0;

    if (qaResults != null) {
      for (Map<String, Object> r : qaResults) {
        try {
          // When the QA model hits its output token cap the response is truncated mid-value and
          // repaired into an object that is structurally valid but has lost its identifying
          // fields. Passing that null to UUID.fromString throws, and because the catch below
          // swallows it the counters stayed at zero — which scored as a clean "passed".
          String rawRegionId = (String) r.get("regionId");
          if (rawRegionId == null || rawRegionId.isBlank()) {
            discardedResults++;
            log.warn(
                "Discarding QA result without a regionId for image {} (likely a truncated model"
                    + " response)",
                imageId);
            continue;
          }
          UUID regionId = UUID.fromString(rawRegionId);
          String qaStatus = (String) r.get("qaStatus");
          Double qaScore = r.get("qaScore") != null ? ((Number) r.get("qaScore")).doubleValue() : null;
          String qaFeedback = (String) r.get("qaFeedback");

          ocrRegionRepository
              .findById(Objects.requireNonNull(regionId))
              .ifPresent(
                  region -> {
                    region.setQaStatus(qaStatus);
                    region.setQaScore(qaScore);
                    region.setQaFeedback(qaFeedback);

                    // Check for direct fix first
                    if ("direct_fix".equalsIgnoreCase(qaStatus) && r.containsKey("directFix")) {
                      Map<?, ?> directFix = (Map<?, ?>) r.get("directFix");
                      // Find the layer element in the translation layer
                      List<LayerElement> elements = layerElementRepository.findByRegionId(regionId);
                      for (LayerElement el : elements) {
                        if ("translation".equalsIgnoreCase(el.getLayer().getType())) {
                          if (directFix.containsKey("correctedText")) {
                            el.setText((String) directFix.get("correctedText"));
                            region.setTranslatedText((String) directFix.get("correctedText"));
                          }
                          if (directFix.containsKey("suggestedFontSize")) {
                            el.setSize(((Number) directFix.get("suggestedFontSize")).doubleValue());
                          }
                          layerElementRepository.save(Objects.requireNonNull(el));
                        }
                      }
                      region.setQaStatus("fixed");
                    } else if ("failed".equalsIgnoreCase(qaStatus) && r.containsKey("escalation")) {
                      Map<?, ?> escalation = (Map<?, ?>) r.get("escalation");

                      if (Boolean.TRUE.equals(escalation.get("needsManualIntervention"))) {
                        region.setQaStatus("manual_review");
                      } else if (Boolean.TRUE.equals(escalation.get("needsReOcr"))) {
                        regionsToReOcr.add(regionId.toString());
                      } else if (Boolean.TRUE.equals(escalation.get("ocrBad"))
                          && escalation.containsKey("correctedSourceText")) {
                        region.setText((String) escalation.get("correctedSourceText"));
                      }

                      if (Boolean.TRUE.equals(escalation.get("orderBad"))
                          && escalation.containsKey("suggestedReadingOrderIndex")) {
                        region.setBubbleReadingOrder(
                            ((Number) escalation.get("suggestedReadingOrderIndex")).intValue());
                      }
                    } else if ("reject_sfx".equalsIgnoreCase(qaStatus)) {
                      hideTranslationElements(regionId, null);
                    }
                    ocrRegionRepository.save(Objects.requireNonNull(region));

                    stats[0]++;
                    String finalStatus = region.getQaStatus();
                    if ("passed".equalsIgnoreCase(finalStatus)) {
                      stats[1]++;
                    } else if ("failed".equalsIgnoreCase(finalStatus)) {
                      stats[2]++;
                    } else if ("fixed".equalsIgnoreCase(finalStatus)
                        || "direct_fix".equalsIgnoreCase(finalStatus)) {
                      stats[3]++;
                    } else if ("manual_review".equalsIgnoreCase(finalStatus)) {
                      stats[4]++;
                    }
                    if (qaScore != null) {
                      scoreStats[0] += qaScore;
                      scoreStats[1]++;
                    }

                    if (!"passed".equalsIgnoreCase(finalStatus)) {
                      Map<String, Object> failedInfo = new HashMap<>();
                      failedInfo.put("regionId", regionId.toString());
                      failedInfo.put("bubbleReadingOrder", region.getBubbleReadingOrder());
                      failedInfo.put("qaStatus", finalStatus);
                      failedInfo.put("qaScore", qaScore);
                      failedInfo.put("qaFeedback", qaFeedback);
                      if (r.containsKey("escalation")) {
                        failedInfo.put("escalation", r.get("escalation"));
                      }
                      failedRegionsList.add(failedInfo);
                    }
                  });

          if ("failed".equalsIgnoreCase(qaStatus)) {
            if (r.containsKey("escalation")
                && Boolean.TRUE.equals(
                    ((Map<?, ?>) r.get("escalation")).get("needsManualIntervention"))) {
              needsManualIntervention = true;
            } else {
              needsRetry = true;
            }
          }
        } catch (Exception e) {
          discardedResults++;
          log.error("Error processing QA result for region", e);
        }
      }
    }

    // A QA pass that scored nothing is not a QA pass. Reporting it as one marked the pipeline
    // complete with QA never actually applied, and stamped "passed / total_regions: 0" over the
    // page's translation layers.
    final boolean qaUnusable = discardedResults > 0 && stats[0] == 0;
    if (qaUnusable) {
      log.error(
          "QA produced no usable results for image {} ({} discarded). Not reporting a pass.",
          imageId,
          discardedResults);
    }

    Page qaPage = resolvePageForCallback(imageId, callbackPageId);
    UUID qaPageId = qaPage != null ? qaPage.getId() : null;
    String retryKey = qaRetryKey(imageId, qaPageId);
    String retryValStr = redisTemplate.opsForValue().get(retryKey);
    int retries = retryValStr != null ? Integer.parseInt(retryValStr) : 0;

    // Save QA info into translation layer metadata_json
    try {
      List<Layer> layers = qaPage == null ? List.of() : layerRepository.findByPageId(qaPageId);

      // Only the newest translation layer belongs to this QA pass. Writing to every translation
      // layer on the page meant the final callback of a QA retry cycle overwrote the per-cycle
      // results already recorded on the earlier layers.
      Layer newestTranslationLayer =
          layers.stream()
              .filter(l -> "translation".equalsIgnoreCase(l.getType()))
              .max(
                  Comparator.comparing(
                      Layer::getCreatedAt, Comparator.nullsFirst(Comparator.naturalOrder())))
              .orElse(null);

      if (newestTranslationLayer != null) {
          Layer layer = newestTranslationLayer;
          com.fasterxml.jackson.databind.node.ObjectNode metadata = layer.getMetadataJson() != null
              && layer.getMetadataJson().isObject()
                  ? (com.fasterxml.jackson.databind.node.ObjectNode) layer.getMetadataJson()
                  : objectMapper.createObjectNode();

          com.fasterxml.jackson.databind.node.ObjectNode qaNode = objectMapper.createObjectNode();

          String status = "passed";
          if (qaUnusable) {
            status = "error";
          } else if (needsManualIntervention || stats[4] > 0) {
            status = "manual_review";
          } else if (stats[2] > 0) {
            status = needsRetry ? "partial_pass" : "failed";
          } else if (stats[3] > 0) {
            status = "partial_pass";
          }

          qaNode.put("status", status);
          if (discardedResults > 0) {
            qaNode.put("discarded_results", discardedResults);
          }
          qaNode.put("total_regions", stats[0]);
          qaNode.put("passed", stats[1]);
          qaNode.put("failed", stats[2]);
          qaNode.put("direct_fix", stats[3]);
          qaNode.put("manual_review", stats[4]);
          qaNode.put("avg_score", scoreStats[1] > 0 ? (scoreStats[0] / scoreStats[1]) : 0.0);
          qaNode.put("last_qa_at", OffsetDateTime.now().toString());
          qaNode.put("retries_used", retries);

          com.fasterxml.jackson.databind.node.ArrayNode failedRegionsNode = objectMapper.createArrayNode();
          for (Map<String, Object> failedRegion : failedRegionsList) {
            failedRegionsNode.add(objectMapper.valueToTree(failedRegion));
          }
          qaNode.set("failed_regions", failedRegionsNode);

          if (cost != null) {
            qaNode.set("cost", objectMapper.valueToTree(cost));
            saveJobCosts(imageId, cost);
          }

          metadata.set("qa", qaNode);

          // Legacy layer_name logic for manual review
          if (needsManualIntervention) {
            String currentName = metadata.has("layer_name") ? metadata.get("layer_name").asText() : "Translation";
            if (!currentName.contains("qa-manual-review-needed")) {
              metadata.put("layer_name", currentName + " (qa-manual-review-needed)");
            }
          }

          layer.setMetadataJson(metadata);
          layerRepository.save(Objects.requireNonNull(layer));
      }
    } catch (Exception e) {
      log.error("Failed to update layer metadata with QA results", e);
    }

    if (needsManualIntervention) {
      log.warn("QA requested manual intervention for image {}. Halting pipeline.", imageId);
      redisTemplate.delete(Objects.requireNonNull(retryKey));
      redisTemplate.delete("pipeline:trace:" + imageId);
      return "MANUAL_REVIEW";
    } else if (needsRetry && retries < 2) {
      redisTemplate
          .opsForValue()
          .set(
              Objects.requireNonNull(retryKey),
              Objects.requireNonNull(String.valueOf(retries + 1)));

      if (!regionsToReOcr.isEmpty()) {
        log.info(
            "QA failed for image {} with Re-OCR request. Retry {}/2. Enqueuing qa-re-ocr job...",
            imageId,
            retries + 1);
        List<String> regionsToReOcrPayload = List.copyOf(regionsToReOcr);
        enqueueJobForPage(
            "qa-re-ocr",
            imageId,
            qaPageId,
            "high",
            job -> job.put("regionsToReOcr", regionsToReOcrPayload));
      } else {
        log.info(
            "QA failed for image {}. Retry {}/2. Enqueuing translation job...",
            imageId,
            retries + 1);
        redisTemplate
            .opsForValue()
            .set("image:translation:reason:" + imageId, "qa-re-translate", REDO_REASON_TTL);
        enqueueJobForPage("translation", imageId, qaPageId);
      }
      return "RETRIED";
    } else {
      if (needsRetry) {
        log.warn("QA failed for image {} but reached max retries. Completing pipeline.", imageId);
      } else if (qaUnusable) {
        log.warn(
            "QA returned no usable results for image {}. Completing pipeline without a QA verdict.",
            imageId);
      } else {
        log.info("QA passed for image {}. Pipeline complete!", imageId);
      }
      redisTemplate.delete(Objects.requireNonNull(retryKey));
      redisTemplate.delete("pipeline:trace:" + imageId);
      return qaUnusable ? "COMPLETED_NO_QA" : "COMPLETED";
    }
  }

  /**
   * Hide the typeset text for a region QA judged to be a sound effect.
   *
   * <p>The QA prompt has told the model since it was written that {@code reject_sfx} means
   * "downstream will hide the element". Nothing downstream did. The status was written onto the
   * region and no element was ever touched, so a region the reviewer had explicitly asked to be
   * removed was typeset anyway — on the 2026-08-12 QA run that is both of the page-2 rejections,
   * one of which became the literal string "[Illegible sign]" printed over the artwork and the
   * other an invented sentence over a scream.
   *
   * <p>Hiding rather than deleting: the element carries the region's geometry and the reviewer's
   * reasoning, an editor may disagree, and the renderer skips invisible elements anyway.
   *
   * @param latestTranslationLayer when non-null, restrict to that layer; older translation layers
   *     are already invisible and rewriting them would edit superseded history.
   */
  private void hideTranslationElements(UUID regionId, Layer latestTranslationLayer) {
    for (LayerElement el : layerElementRepository.findByRegionId(regionId)) {
      if (el.getLayer() == null || !"translation".equalsIgnoreCase(el.getLayer().getType())) {
        continue;
      }
      if (latestTranslationLayer != null && !el.getLayer().getId().equals(latestTranslationLayer.getId())) {
        continue;
      }
      el.setVisible(false);
      layerElementRepository.save(Objects.requireNonNull(el));
      log.info("QA rejected region {} as SFX — hiding its typeset element {}", regionId, el.getId());
    }
  }

  private Panel findMatchingPanel(int rx, int ry, int rw, int rh, List<Panel> panels) {
    Panel bestPanel = null;
    double maxOverlapArea = 0;

    for (Panel p : panels) {
      int overlapX = Math.max(0, Math.min(rx + rw, p.getBboxX() + p.getBboxW()) - Math.max(rx, p.getBboxX()));
      int overlapY = Math.max(0, Math.min(ry + rh, p.getBboxY() + p.getBboxH()) - Math.max(ry, p.getBboxY()));
      double overlapArea = overlapX * overlapY;

      if (overlapArea > maxOverlapArea) {
        maxOverlapArea = overlapArea;
        bestPanel = p;
      }
    }
    return bestPanel;
  }

  private String getContrastingTextColor(String hexColor) {
    if (hexColor == null || !hexColor.startsWith("#") || hexColor.length() < 7) {
      return "#000000";
    }
    try {
      int r = Integer.parseInt(hexColor.substring(1, 3), 16);
      int g = Integer.parseInt(hexColor.substring(3, 5), 16);
      int b = Integer.parseInt(hexColor.substring(5, 7), 16);
      double luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
      return luminance < 0.5 ? "#ffffff" : "#000000";
    } catch (Exception e) {
      return "#000000";
    }
  }

  private void saveJobCosts(UUID imageId, Map<String, Object> costMap) {
    if (costMap == null || costMap.isEmpty())
      return;
    try {
      if (costMap.get("breakdown") instanceof List<?> breakdown) {
        for (Object entry : breakdown) {
          if (entry instanceof Map<?, ?> costEntry) {
            saveJobCostEntry(imageId, stringKeyedMap(costEntry));
          }
        }
      } else if (costMap.containsKey("estimated_cost")) {
        saveJobCostEntry(imageId, costMap);
      }
    } catch (Exception e) {
      log.error("Error saving job costs for image " + imageId, e);
    }
  }

  private Map<String, Object> stringKeyedMap(Map<?, ?> source) {
    Map<String, Object> result = new HashMap<>();
    source.forEach(
        (key, value) -> {
          if (key instanceof String stringKey) {
            result.put(stringKey, value);
          }
        });
    return result;
  }

  private void saveJobCostEntry(UUID imageId, Map<String, Object> cost) {
    JobCost jobCost = new JobCost();
    jobCost.setImageId(imageId);
    if (cost.get("provider") != null)
      jobCost.setProvider(cost.get("provider").toString());
    if (cost.get("model") != null)
      jobCost.setModel(cost.get("model").toString());
    if (cost.get("prompt_tokens") instanceof Number promptTokens) {
      jobCost.setPromptTokens(promptTokens.intValue());
    }
    if (cost.get("completion_tokens") instanceof Number completionTokens) {
      jobCost.setCompletionTokens(completionTokens.intValue());
    }
    if (cost.get("estimated_cost") instanceof Number estimatedCost) {
      jobCost.setEstimatedCost(estimatedCost.doubleValue());
    }
    jobCostRepository.save(jobCost);
  }
}
