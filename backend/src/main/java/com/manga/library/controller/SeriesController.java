package com.manga.library.controller;

import com.manga.library.dto.ChapterDto;
import com.manga.library.dto.SeriesDto;
import com.manga.library.dto.SystemSettingsDto;
import com.manga.library.dto.ZipImageEntry;
import com.manga.library.exception.ResourceNotFoundException;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.manga.library.service.*;
import io.minio.errors.MinioException;
import java.io.IOException;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/series")
public class SeriesController {
  private static final org.slf4j.Logger log =
      org.slf4j.LoggerFactory.getLogger(SeriesController.class);

  private final SeriesRepository seriesRepository;
  private final ChapterRepository chapterRepository;
  private final PageRepository pageRepository;
  private final ImageRepository imageRepository;
  private final LayerRepository layerRepository;
  private final PageService pageService;
  private final MinioService minioService;
  private final JobCoordinatorService jobCoordinatorService;
  private final ChapterExportService chapterExportService;
  private final SystemSettingsService systemSettingsService;

  public SeriesController(
      SeriesRepository seriesRepository,
      ChapterRepository chapterRepository,
      PageRepository pageRepository,
      ImageRepository imageRepository,
      LayerRepository layerRepository,
      PageService pageService,
      MinioService minioService,
      JobCoordinatorService jobCoordinatorService,
      ChapterExportService chapterExportService,
      SystemSettingsService systemSettingsService) {
    this.seriesRepository = seriesRepository;
    this.chapterRepository = chapterRepository;
    this.pageRepository = pageRepository;
    this.imageRepository = imageRepository;
    this.layerRepository = layerRepository;
    this.pageService = pageService;
    this.minioService = minioService;
    this.jobCoordinatorService = jobCoordinatorService;
    this.chapterExportService = chapterExportService;
    this.systemSettingsService = systemSettingsService;
  }

  @org.springframework.beans.factory.annotation.Value("${server.servlet.context-path:}")
  private String contextPath;

  private String getImageUrl(UUID imageId) {
    String cleanContext = contextPath == null ? "" : contextPath;
    if (cleanContext.endsWith("/")) {
      cleanContext = cleanContext.substring(0, cleanContext.length() - 1);
    }
    return cleanContext + "/api/images/" + imageId + "/thumbnail";
  }

  /**
   * Whether any of a slot's fields is set at this level, using the pipeline's own definition of
   * "set" so that `source` cannot claim an override for a value the pipeline treats as a
   * placeholder.
   */
  private static boolean hasOverride(String... values) {
    for (String v : values) {
      if (JobCoordinatorService.isOverride(v))
        return true;
    }
    return false;
  }

  private String resolveSetting(String value) {
    if (value != null && (value.equals("inherit") || value.equals("default") || value.isBlank())) {
      return null;
    }
    return value;
  }

  private SeriesDto toDto(Series s) {
    Boolean resolvedUseFallbackModels = s.getUseFallbackModels();
    if (resolvedUseFallbackModels == null) {
      SystemSettingsDto globalSettings = systemSettingsService.getSettings();
      if (globalSettings != null && globalSettings.useFallbackModels() != null) {
        resolvedUseFallbackModels = globalSettings.useFallbackModels();
      } else {
        resolvedUseFallbackModels = true;
      }
    }

    return new SeriesDto(
        s.getId(),
        s.getTitle(),
        s.getOriginalLanguage(),
        s.getSourceLanguage(),
        s.getTargetLanguage(),
        s.getReadingDirection(),
        s.getCoverImageId() != null ? getImageUrl(s.getCoverImageId()) : null,
        s.getOcrProvider(),
        s.getOcrModel(),
        s.getTlProvider(),
        s.getTlModel(),
        s.getQaProvider(),
        s.getQaLlmModel(),
        s.getQaVlmModel(),
        s.getQaMode(),
        s.getRoutingStrategy(),
        s.getUseFallbackModels(),
        resolvedUseFallbackModels,
        s.getCreatedAt(),
        s.getUpdatedAt());
  }

  private ChapterDto toChapterDto(Chapter c, SystemSettingsDto globalSettings) {
    Series series = c.getSeries();
    String gOcrProvider = globalSettings != null ? globalSettings.ocrProvider() : null;
    String gOcrModel = globalSettings != null ? globalSettings.ocrModel() : null;
    String gTlProvider = globalSettings != null ? globalSettings.tlProvider() : null;
    String gTlModel = globalSettings != null ? globalSettings.tlModel() : null;
    String gQaProvider = globalSettings != null ? globalSettings.qaProvider() : null;
    String gQaLlmModel = globalSettings != null ? globalSettings.qaLlmModel() : null;
    String gQaVlmModel = globalSettings != null ? globalSettings.qaVlmModel() : null;
    String gQaMode = globalSettings != null ? globalSettings.qaMode() : null;

    // -------------------------------------------------------------------------------------
    // MODEL INHERITANCE LOGIC:
    // Overrides fall back using a Chapter -> Series -> Global hierarchy, and every field falls
    // back INDEPENDENTLY. A chapter may set a model without setting a provider, in which case the
    // model comes from the chapter and the provider from the series or global settings.
    //
    // This must agree with JobCoordinatorService.enqueueJobDirectly, which is what builds the job
    // payload the worker actually runs, so it calls the very same resolvers with the very same
    // task keys rather than reimplementing them. The two used to be separate implementations, and
    // the display copy resolved provider and model as a coupled pair: it chose a level based on the
    // provider alone and then took that level's model, discarding a chapter-level model whenever
    // the chapter left the provider unset. The card then advertised a model the pipeline never used.
    //
    // NOTE: do NOT reach for resolveConfigForChapter here. Despite the name it is not on the
    // dispatch path — only the duplicate-page comparison uses it — and it passes task keys
    // ("translation", "qa") that do not exist in providers.json, so its models always collapse to
    // the global default (AUDIT-P1). enqueueJobDirectly is the authority.
    //
    // resolveModel/resolveModelWithCheck take explicit values and touch no settings, so calling
    // them per chapter costs nothing extra.
    // The frontend relies on this resolved state in `ResolvedModelSlot` and `ResolvedQaSlot`.
    // -------------------------------------------------------------------------------------

    String sOcrProvider = series != null ? series.getOcrProvider() : null;
    String sOcrModel = series != null ? series.getOcrModel() : null;
    String sTlProvider = series != null ? series.getTlProvider() : null;
    String sTlModel = series != null ? series.getTlModel() : null;
    String sQaProvider = series != null ? series.getQaProvider() : null;
    String sQaLlmModel = series != null ? series.getQaLlmModel() : null;
    String sQaVlmModel = series != null ? series.getQaVlmModel() : null;
    String sQaMode = series != null ? series.getQaMode() : null;

    String ocrProv = jobCoordinatorService.resolveModel(c.getOcrProvider(), sOcrProvider, gOcrProvider);
    // enqueueJobDirectly resolves ocrModel with a plain resolveModel — no validity check — so
    // this must not add one, or the card would show a global default the worker never receives.
    String ocrMod =
        "local".equals(ocrProv)
            ? (globalSettings != null ? globalSettings.localOcrModel() : null)
            : jobCoordinatorService.resolveModel(c.getOcrModel(), sOcrModel, gOcrModel);
    String ocrSrc =
        hasOverride(c.getOcrProvider(), c.getOcrModel())
            ? "chapter"
            : hasOverride(sOcrProvider, sOcrModel) ? "series" : "global";
    var resolvedOcr = new ChapterDto.ResolvedModelSlot(ocrProv, ocrMod, ocrSrc);

    String tlProv = jobCoordinatorService.resolveModel(c.getTlProvider(), sTlProvider, gTlProvider);
    String tlMod =
        jobCoordinatorService.resolveModelWithCheck(
            c.getTlModel(), sTlModel, gTlModel, tlProv, "tl");
    String tlSrc =
        hasOverride(c.getTlProvider(), c.getTlModel())
            ? "chapter"
            : hasOverride(sTlProvider, sTlModel) ? "series" : "global";
    var resolvedTranslation = new ChapterDto.ResolvedModelSlot(tlProv, tlMod, tlSrc);

    String qaProv = jobCoordinatorService.resolveModel(c.getQaProvider(), sQaProvider, gQaProvider);
    // Task keys must match providers.json exactly: tl / qaLLM / qaVLM / ocr.
    String qaLlm =
        jobCoordinatorService.resolveModelWithCheck(
            c.getQaLlmModel(), sQaLlmModel, gQaLlmModel, qaProv, "qaLLM");
    String qaVlm =
        jobCoordinatorService.resolveModelWithCheck(
            c.getQaVlmModel(), sQaVlmModel, gQaVlmModel, qaProv, "qaVLM");
    String qaMod = jobCoordinatorService.resolveModel(c.getQaMode(), sQaMode, gQaMode);
    String qaSrc =
        hasOverride(c.getQaProvider(), c.getQaLlmModel(), c.getQaVlmModel(), c.getQaMode())
            ? "chapter"
            : hasOverride(sQaProvider, sQaLlmModel, sQaVlmModel, sQaMode) ? "series" : "global";
    var resolvedQa = new ChapterDto.ResolvedQaSlot(qaProv, qaLlm, qaVlm, qaMod, qaSrc);

    Boolean resolvedUseFallbackModels = c.getUseFallbackModels();
    if (resolvedUseFallbackModels == null && series != null) {
      resolvedUseFallbackModels = series.getUseFallbackModels();
    }
    if (resolvedUseFallbackModels == null && globalSettings != null && globalSettings.useFallbackModels() != null) {
      resolvedUseFallbackModels = globalSettings.useFallbackModels();
    }
    if (resolvedUseFallbackModels == null) {
      resolvedUseFallbackModels = true;
    }

    return new ChapterDto(
        c.getId(),
        c.getSeries() != null ? c.getSeries().getId() : null,
        c.getChapterNumber(),
        c.getTitle(),
        c.getCoverImageId() != null ? getImageUrl(c.getCoverImageId()) : null,
        c.getOcrProvider(),
        c.getOcrModel(),
        c.getTlProvider(),
        c.getTlModel(),
        c.getQaProvider(),
        c.getQaLlmModel(),
        c.getQaVlmModel(),
        c.getQaMode(),
        c.getRoutingStrategy(),
        c.getUseContextMemory(),
        c.getUseFallbackModels(),
        resolvedUseFallbackModels,
        (int) pageRepository.countByChapterId(c.getId()),
        c.getCreatedAt(),
        c.getUpdatedAt(),
        resolvedOcr,
        resolvedTranslation,
        resolvedQa);
  }

  @PostMapping
  @org.springframework.security.access.prepost.PreAuthorize(
      "hasAnyRole('ADMIN', 'TRANSLATOR', 'VIEWER')")
  public ResponseEntity<SeriesDto> createSeries(
      @RequestBody SeriesDto dto, @AuthenticationPrincipal User user) {
    String sourceLang =
        resolveSetting(
            dto.sourceLanguage() != null ? dto.sourceLanguage() : dto.originalLanguage());
    String targetLang = resolveSetting(dto.targetLanguage());
    if (targetLang == null) targetLang = "en";

    String origLang = resolveSetting(sourceLang);
    if (origLang == null) origLang = "ja";

    Series series = new Series();
    series.setTitle(dto.title());
    series.setOriginalLanguage(origLang);
    series.setSourceLanguage(origLang);
    series.setTargetLanguage(targetLang);
    series.setReadingDirection(resolveSetting(dto.readingDirection()));
    series.setOcrProvider(resolveSetting(dto.ocrProvider()));
    series.setOcrModel(resolveSetting(dto.ocrModel()));
    series.setTlProvider(resolveSetting(dto.tlProvider()));
    series.setTlModel(resolveSetting(dto.tlModel()));
    series.setQaProvider(resolveSetting(dto.qaProvider()));
    series.setQaLlmModel(resolveSetting(dto.qaLlmModel()));
    series.setQaVlmModel(resolveSetting(dto.qaVlmModel()));
    series.setQaMode(resolveSetting(dto.qaMode()));
    series.setRoutingStrategy(resolveSetting(dto.routingStrategy()));
    series.setUseFallbackModels(dto.useFallbackModels());
    series.setCreatedBy(user);
    Objects.requireNonNull(series, "series cannot be null");
    series = seriesRepository.save(Objects.requireNonNull(series));

    return ResponseEntity.ok(toDto(series));
  }

  /** Only these fields may be sorted on; an unrecognized value falls back to {@code updatedAt}. */
  private static final java.util.Set<String> SERIES_SORT_FIELDS =
      java.util.Set.of("createdAt", "updatedAt");

  @GetMapping
  public ResponseEntity<com.manga.library.dto.PagedResponse<SeriesDto>> listSeries(
      @org.springframework.data.web.PageableDefault(size = 10) org.springframework.data.domain.Pageable unsortedPageable,
      @RequestParam(value = "sortBy", defaultValue = "updatedAt") String sortBy,
      @RequestParam(value = "sortDir", defaultValue = "desc") String sortDir) {
    String resolvedSortBy = SERIES_SORT_FIELDS.contains(sortBy) ? sortBy : "updatedAt";
    org.springframework.data.domain.Sort.Direction direction =
        "asc".equalsIgnoreCase(sortDir)
            ? org.springframework.data.domain.Sort.Direction.ASC
            : org.springframework.data.domain.Sort.Direction.DESC;
    org.springframework.data.domain.Pageable pageable =
        org.springframework.data.domain.PageRequest.of(
            unsortedPageable.getPageNumber(),
            unsortedPageable.getPageSize(),
            org.springframework.data.domain.Sort.by(direction, resolvedSortBy));

    org.springframework.data.domain.Page<Series> seriesPage = seriesRepository.findAll(pageable);
    return ResponseEntity.ok(
        com.manga.library.dto.PagedResponse.from(seriesPage, this::toDto));
  }


  private void handleDuplicateImageCloning(Page newPage, Image existingImage, Chapter targetChapter) {
    List<Page> existingPages = pageRepository.findByImageId(existingImage.getId());
    if (existingPages.isEmpty()) return;

    // Prefer the same chapter, then the same series, then anything else; break ties on the
    // lowest page id so the choice is deterministic across retries.
    Comparator<Page> byAffinity = Comparator
        .comparingInt((Page p) -> p.getChapter().getId().equals(targetChapter.getId()) ? 2 :
             p.getChapter().getSeries() != null && targetChapter.getSeries() != null &&
             p.getChapter().getSeries().getId().equals(targetChapter.getSeries().getId()) ? 1 : 0)
        .reversed()
        .thenComparing(Page::getId);

    Page sourcePage = existingPages.stream()
        .filter(p -> !p.getId().equals(newPage.getId()))
        .filter(p -> layerRepository.findByPageId(p.getId()).stream().anyMatch(l -> "ocr".equals(l.getType())))
        .min(byAffinity)
        .orElse(null);

    if (sourcePage == null) {
      jobCoordinatorService.startPipeline(
          newPage.getImage().getId(), newPage.getId(), targetChapter.getId());
      return;
    }

    JobCoordinatorService.ResolvedPipelineConfig sourceConfig = jobCoordinatorService.resolveConfigForChapter(sourcePage.getChapter());
    JobCoordinatorService.ResolvedPipelineConfig targetConfig = jobCoordinatorService.resolveConfigForChapter(targetChapter);

    boolean ocrMatches = Objects.equals(sourceConfig.ocrProvider(), targetConfig.ocrProvider()) &&
                         Objects.equals(sourceConfig.ocrModel(), targetConfig.ocrModel());

    if (!ocrMatches) {
      jobCoordinatorService.startPipeline(
          newPage.getImage().getId(), newPage.getId(), targetChapter.getId());
      return;
    }

    Map<UUID, UUID> regionMap = pageService.cloneOcrData(sourcePage, newPage);

    boolean tlMatches = Objects.equals(sourceConfig.tlProvider(), targetConfig.tlProvider()) &&
                        Objects.equals(sourceConfig.tlModel(), targetConfig.tlModel()) &&
                        Objects.equals(sourceConfig.qaProvider(), targetConfig.qaProvider()) &&
                        Objects.equals(sourceConfig.qaMode(), targetConfig.qaMode());

    if (tlMatches) {
      pageService.cloneTranslationData(sourcePage, newPage, regionMap);
      jobCoordinatorService.triggerPageRedo(newPage.getId(), "render", targetChapter.getId());
    } else {
      jobCoordinatorService.triggerPageRedo(newPage.getId(), "translation", targetChapter.getId());
    }
  }

  @GetMapping("/{seriesId}")
  public ResponseEntity<SeriesDto> getSeries(@PathVariable UUID seriesId) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    return seriesRepository
        .findById(Objects.requireNonNull(seriesId))
        .map(s -> ResponseEntity.ok(toDto(s)))
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/{seriesId}/chapters")
  @org.springframework.security.access.prepost.PreAuthorize(
      "hasAnyRole('ADMIN', 'TRANSLATOR', 'VIEWER')")
  @org.springframework.transaction.annotation.Transactional
  public ResponseEntity<?> createChapter(@PathVariable UUID seriesId, @RequestBody ChapterDto dto) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    Series series =
        seriesRepository
            .findById(Objects.requireNonNull(seriesId))
            .orElseThrow(() -> new ResourceNotFoundException("Series not found: " + seriesId));

    if (chapterRepository
        .findBySeriesIdAndChapterNumber(seriesId, dto.chapterNumber())
        .isPresent()) {
      return ResponseEntity.status(409)
          .body(
              Map.of(
                  "message",
                  "Chapter "
                      + dto.chapterNumber()
                      + " already exists in this series. Please select a different chapter number."));
    }

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(dto.chapterNumber());
    chapter.setTitle(dto.title());
    chapter.setOcrProvider(resolveSetting(dto.ocrProvider()));
    chapter.setOcrModel(resolveSetting(dto.ocrModel()));
    chapter.setTlProvider(resolveSetting(dto.tlProvider()));
    chapter.setTlModel(resolveSetting(dto.tlModel()));
    chapter.setQaProvider(resolveSetting(dto.qaProvider()));
    chapter.setQaLlmModel(resolveSetting(dto.qaLlmModel()));
    chapter.setQaVlmModel(resolveSetting(dto.qaVlmModel()));
    chapter.setQaMode(resolveSetting(dto.qaMode()));
    chapter.setRoutingStrategy(resolveSetting(dto.routingStrategy()));
    chapter.setUseContextMemory(dto.useContextMemory() == null || dto.useContextMemory());
    chapter.setUseFallbackModels(dto.useFallbackModels());
    Objects.requireNonNull(chapter, "chapter cannot be null");
    chapter = chapterRepository.save(Objects.requireNonNull(chapter));

    ChapterDto responseDto = toChapterDto(chapter, systemSettingsService.getSettings());
    return ResponseEntity.ok(responseDto);
  }

  @GetMapping("/{seriesId}/chapters")
  @org.springframework.transaction.annotation.Transactional(readOnly = true)
  public ResponseEntity<com.manga.library.dto.PagedResponse<ChapterDto>> listChapters(
      @PathVariable UUID seriesId,
      @org.springframework.data.web.PageableDefault(size = 15) org.springframework.data.domain.Pageable unsortedPageable,
      @RequestParam(value = "sortDir", defaultValue = "asc") String sortDir) {
    org.springframework.data.domain.Sort.Direction direction =
        "desc".equalsIgnoreCase(sortDir)
            ? org.springframework.data.domain.Sort.Direction.DESC
            : org.springframework.data.domain.Sort.Direction.ASC;
    org.springframework.data.domain.Pageable pageable =
        org.springframework.data.domain.PageRequest.of(
            unsortedPageable.getPageNumber(),
            unsortedPageable.getPageSize(),
            org.springframework.data.domain.Sort.by(direction, "chapterNumber"));

    org.springframework.data.domain.Page<Chapter> chapterPage =
        chapterRepository.findBySeriesId(seriesId, pageable);
    SystemSettingsDto globalSettings = systemSettingsService.getSettings();

    return ResponseEntity.ok(
        com.manga.library.dto.PagedResponse.from(
            chapterPage, c -> toChapterDto(c, globalSettings)));
  }

  @GetMapping("/chapters/{chapterId}")
  @org.springframework.transaction.annotation.Transactional(readOnly = true)
  public ResponseEntity<ChapterDto> getChapter(@PathVariable UUID chapterId) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository
        .findById(Objects.requireNonNull(chapterId))
        .map(
            c -> {
              ChapterDto dto = toChapterDto(c, systemSettingsService.getSettings());
              return ResponseEntity.ok(dto);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PutMapping("/{seriesId}")
  @org.springframework.security.access.prepost.PreAuthorize(
      "hasAnyRole('ADMIN', 'TRANSLATOR', 'VIEWER')")
  public ResponseEntity<SeriesDto> updateSeries(
      @PathVariable UUID seriesId, @RequestBody SeriesDto dto) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    return seriesRepository
        .findById(Objects.requireNonNull(seriesId))
        .map(
            s -> {
              s.setTitle(dto.title());
              String sourceLang =
                  resolveSetting(
                      dto.sourceLanguage() != null ? dto.sourceLanguage() : dto.originalLanguage());
              String targetLang = resolveSetting(dto.targetLanguage());
              if (targetLang == null) targetLang = "en";

              String origLang = resolveSetting(sourceLang);
              if (origLang == null) origLang = "ja";

              s.setOriginalLanguage(origLang);
              s.setSourceLanguage(origLang);
              s.setTargetLanguage(targetLang);
              s.setReadingDirection(resolveSetting(dto.readingDirection()));
              s.setOcrProvider(resolveSetting(dto.ocrProvider()));
              s.setOcrModel(resolveSetting(dto.ocrModel()));
              s.setTlProvider(resolveSetting(dto.tlProvider()));
              s.setTlModel(resolveSetting(dto.tlModel()));
              s.setQaProvider(resolveSetting(dto.qaProvider()));
              s.setQaLlmModel(resolveSetting(dto.qaLlmModel()));
              s.setQaVlmModel(resolveSetting(dto.qaVlmModel()));
              s.setQaMode(resolveSetting(dto.qaMode()));
              s.setRoutingStrategy(resolveSetting(dto.routingStrategy()));
              s.setUseFallbackModels(dto.useFallbackModels());
              Objects.requireNonNull(s, "series cannot be null");
              s = seriesRepository.save(Objects.requireNonNull(s));
              return ResponseEntity.ok(toDto(s));
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/{seriesId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasRole('ADMIN')")
  public ResponseEntity<Void> deleteSeries(@PathVariable UUID seriesId) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    if (seriesRepository.existsById(seriesId)) {
      seriesRepository.deleteById(Objects.requireNonNull(seriesId));
      return ResponseEntity.ok().build();
    }
    return ResponseEntity.notFound().build();
  }

  @PutMapping("/chapters/{chapterId}")
  @org.springframework.security.access.prepost.PreAuthorize(
      "hasAnyRole('ADMIN', 'TRANSLATOR', 'VIEWER')")
  @org.springframework.transaction.annotation.Transactional
  public ResponseEntity<?> updateChapter(
      @PathVariable UUID chapterId, @RequestBody ChapterDto dto) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository
        .findById(Objects.requireNonNull(chapterId))
        .map(
            c -> {
              java.util.Optional<Chapter> existing =
                  chapterRepository.findBySeriesIdAndChapterNumber(
                      c.getSeries().getId(), dto.chapterNumber());
              if (existing.isPresent() && !existing.get().getId().equals(c.getId())) {
                return ResponseEntity.status(409)
                    .body(
                        Map.of(
                            "message",
                            "Chapter "
                                + dto.chapterNumber()
                                + " already exists in this series. Please select a different chapter number."));
              }
              c.setTitle(dto.title());
              c.setChapterNumber(dto.chapterNumber());
              c.setOcrProvider(resolveSetting(dto.ocrProvider()));
              c.setOcrModel(resolveSetting(dto.ocrModel()));
              c.setTlProvider(resolveSetting(dto.tlProvider()));
              c.setTlModel(resolveSetting(dto.tlModel()));
              c.setQaProvider(resolveSetting(dto.qaProvider()));
              c.setQaLlmModel(resolveSetting(dto.qaLlmModel()));
              c.setQaVlmModel(resolveSetting(dto.qaVlmModel()));
              c.setQaMode(resolveSetting(dto.qaMode()));
              c.setRoutingStrategy(resolveSetting(dto.routingStrategy()));
              c.setUseFallbackModels(dto.useFallbackModels());
              if (dto.useContextMemory() != null) {
                c.setUseContextMemory(dto.useContextMemory());
              }
              Objects.requireNonNull(c, "chapter cannot be null");
              c = chapterRepository.save(Objects.requireNonNull(c));

              pageService.recalculateSeriesCover(c.getSeries().getId());

              ChapterDto responseDto = toChapterDto(c, systemSettingsService.getSettings());
              return ResponseEntity.ok(responseDto);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/chapters/{chapterId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  @org.springframework.transaction.annotation.Transactional
  public ResponseEntity<Void> deleteChapter(@PathVariable UUID chapterId) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository
        .findById(Objects.requireNonNull(chapterId))
        .map(
            chapter -> {
              UUID seriesId = chapter.getSeries().getId();
              chapterRepository.delete(Objects.requireNonNull(chapter));
              chapterRepository.flush();
              pageService.recalculateSeriesCover(seriesId);
              return ResponseEntity.ok().<Void>build();
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/{seriesId}/chapters/import")
  @org.springframework.security.access.prepost.PreAuthorize(
      "hasAnyRole('ADMIN', 'TRANSLATOR', 'VIEWER')")
  public ResponseEntity<?> importChapter(
      @PathVariable UUID seriesId,
      @RequestParam("file") MultipartFile file,
      @RequestParam("chapterNumber") Double chapterNumber,
      @RequestParam("title") String title,
      @RequestParam(value = "ocrProvider", required = false) String ocrProvider,
      @RequestParam(value = "ocrModel", required = false) String ocrModel,
      @RequestParam(value = "tlProvider", required = false) String tlProvider,
      @RequestParam(value = "tlModel", required = false) String tlModel,
      @RequestParam(value = "qaProvider", required = false) String qaProvider,
      @RequestParam(value = "qaLlmModel", required = false) String qaLlmModel,
      @RequestParam(value = "qaVlmModel", required = false) String qaVlmModel,
      @RequestParam(value = "qaMode", required = false) String qaMode,
      @RequestParam(value = "routingStrategy", required = false) String routingStrategy,
      @RequestParam(value = "useFallbackModels", required = false) Boolean useFallbackModels,
      @AuthenticationPrincipal User user) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    log.info("Importing chapter {} (num={}) for series {}", title, chapterNumber, seriesId);

    try {
      Series series =
          seriesRepository
              .findById(Objects.requireNonNull(seriesId))
              .orElseThrow(() -> new ResourceNotFoundException("Series not found: " + seriesId));

      if (chapterRepository.findBySeriesIdAndChapterNumber(seriesId, chapterNumber).isPresent()) {
        return ResponseEntity.status(409)
            .body(
                Map.of("message", "Chapter " + chapterNumber + " already exists in this series."));
      }

      // 1. Create the Chapter
      Chapter chapter = new Chapter();
      chapter.setSeries(series);
      chapter.setChapterNumber(chapterNumber);
      chapter.setTitle(title);
      chapter.setOcrProvider(resolveSetting(ocrProvider));
      chapter.setOcrModel(resolveSetting(ocrModel));
      chapter.setTlProvider(resolveSetting(tlProvider));
      chapter.setTlModel(resolveSetting(tlModel));
      chapter.setQaProvider(resolveSetting(qaProvider));
      chapter.setQaLlmModel(resolveSetting(qaLlmModel));
      chapter.setQaVlmModel(resolveSetting(qaVlmModel));
      chapter.setQaMode(resolveSetting(qaMode));
      chapter.setRoutingStrategy(resolveSetting(routingStrategy));
      chapter.setUseFallbackModels(useFallbackModels);
      chapter = chapterRepository.save(Objects.requireNonNull(chapter));

      // 2. Read ZIP/ePub entries
      List<ZipImageEntry> imageEntries = new ArrayList<>();
      try (java.util.zip.ZipInputStream zis =
          new java.util.zip.ZipInputStream(file.getInputStream())) {
        java.util.zip.ZipEntry entry;
        while ((entry = zis.getNextEntry()) != null) {
          if (entry.isDirectory()) continue;
          String name = entry.getName();
          String lowerName = name.toLowerCase();
          if (lowerName.contains("__macosx") || lowerName.contains("/.") || name.startsWith(".")) {
            continue;
          }
          if (lowerName.endsWith(".png")
              || lowerName.endsWith(".jpg")
              || lowerName.endsWith(".jpeg")
              || lowerName.endsWith(".webp")
              || lowerName.endsWith(".gif")) {
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int len;
            while ((len = zis.read(buffer)) > -1) {
              baos.write(buffer, 0, len);
            }
            imageEntries.add(new ZipImageEntry(name, baos.toByteArray()));
          }
        }
      }

      if (imageEntries.isEmpty()) {
        chapterRepository.delete(Objects.requireNonNull(chapter));
        return ResponseEntity.badRequest()
            .body(Map.of("message", "Archive contains no valid image files."));
      }

      // Sort alphabetically by filename to maintain order
      imageEntries.sort(Comparator.comparing(z -> z.name()));

      // 3. Import each page
      int pageNum = 1;
      for (ZipImageEntry imgEntry : imageEntries) {
        log.info(
            "Importing page {}/{} (filename: '{}') for chapter {} (Number {}) of seriesId {}",
            pageNum,
            imageEntries.size(),
            imgEntry.name(),
            chapter.getId(),
            chapter.getChapterNumber(),
            seriesId);
        byte[] originalBytes = imgEntry.bytes();

        // SHA-256 hash
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        byte[] encodedhash = digest.digest(originalBytes);
        StringBuilder hexString = new StringBuilder(2 * encodedhash.length);
        for (byte b : encodedhash) {
          String hex = Integer.toHexString(0xff & b);
          if (hex.length() == 1) hexString.append('0');
          hexString.append(hex);
        }
        String fileHash = hexString.toString();

        // Check duplicate
        java.util.Optional<Image> existingImageOpt = imageRepository.findByHash(fileHash);
        if (existingImageOpt.isPresent()) {
          Image existingImage = existingImageOpt.get();
          Page page =
              pageService.createPageWithExistingImage(chapter, existingImage, pageNum, user);

          handleDuplicateImageCloning(page, existingImage, chapter);

          pageNum++;
          continue;
        }

        String fileExtension = pageService.getFileExtension(imgEntry.name());
        String uuid = UUID.randomUUID().toString();
        String storagePath = "originals/" + uuid + fileExtension;
        String contentType = "image/png";
        if (fileExtension.equalsIgnoreCase(".jpg") || fileExtension.equalsIgnoreCase(".jpeg")) {
          contentType = "image/jpeg";
        } else if (fileExtension.equalsIgnoreCase(".webp")) {
          contentType = "image/webp";
        } else if (fileExtension.equalsIgnoreCase(".gif")) {
          contentType = "image/gif";
        }

        // Upload to MinIO
        minioService.uploadFile(storagePath, originalBytes, contentType);

        // Generate thumbnail
        String thumbnailStoragePath = null;

        // Save records
        Page page =
            pageService.createPageAndImage(
                chapter,
                imgEntry.name(),
                storagePath,
                thumbnailStoragePath,
                pageNum,
                fileHash,
                user);
        pageService.generateAndSaveThumbnailAsync(page.getImage().getId(), uuid, originalBytes);

        // Queue pipeline
        jobCoordinatorService.startPipeline(
            page.getImage().getId(), page.getId(), chapter.getId());
        pageNum++;
      }

      ChapterDto responseDto = toChapterDto(chapter, systemSettingsService.getSettings());
      return ResponseEntity.ok(responseDto);

    } catch (IOException | NoSuchAlgorithmException | MinioException | RuntimeException e) {
      log.error("Failed to import chapter", e);
      return ResponseEntity.internalServerError().body(Map.of("message", e.getMessage()));
    }
  }

  @GetMapping("/chapters/{chapterId}/export")
  @org.springframework.transaction.annotation.Transactional(readOnly = true)
  public ResponseEntity<?> exportChapter(
      @PathVariable UUID chapterId,
      @RequestParam(name = "format", defaultValue = "zip") String format,
      @RequestParam(name = "force", defaultValue = "false") boolean force,
      @AuthenticationPrincipal User user) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");

    // Verify chapter exists before exporting
    chapterRepository
        .findById(Objects.requireNonNull(chapterId))
        .orElseThrow(() -> new ResourceNotFoundException("Chapter not found: " + chapterId));

    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    if (pages == null || pages.isEmpty()) {
      return ResponseEntity.badRequest().body(Map.of("message", "No pages in chapter"));
    }

    String exportId = UUID.randomUUID().toString();
    UUID userId = user != null ? user.getId() : null;

    java.util.concurrent.CompletableFuture.runAsync(
        () -> {
          chapterExportService.buildAndUploadExport(chapterId, userId, force);
        });

    Map<String, String> response = new HashMap<>();
    response.put("status", "accepted");
    response.put("exportId", exportId);
    response.put(
        "message", "Export started in the background. You will be notified when it is ready.");

    return ResponseEntity.status(202).body(response);
  }

  @DeleteMapping("/chapters/{chapterId}/exports")
  public ResponseEntity<?> clearExports(@PathVariable UUID chapterId) {
    chapterExportService.clearChapterExports(chapterId);
    return ResponseEntity.ok(Map.of("message", "Cleared exports for chapter"));
  }

  @GetMapping("/chapters/exports/{exportId}/download")
  public ResponseEntity<?> downloadExport(@PathVariable String exportId) {
    Objects.requireNonNull(exportId, "exportId cannot be null");

    if (!minioService.fileExists("exports/" + exportId + ".zip")) {
      return ResponseEntity.status(org.springframework.http.HttpStatus.GONE)
          .body(Map.of("message", "Export expired, please re-export to download."));
    }

    try {
      byte[] zipBytes;
      try (java.io.InputStream is = minioService.downloadFile("exports/" + exportId + ".zip")) {
        zipBytes = is.readAllBytes();
      }

      org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
      headers.set(
          org.springframework.http.HttpHeaders.CONTENT_DISPOSITION,
          "attachment; filename=export_" + exportId + ".zip");
      headers.set(org.springframework.http.HttpHeaders.CONTENT_TYPE, "application/zip");

      return ResponseEntity.ok().headers(headers).body(zipBytes);
    } catch (Exception e) {
      log.error("Failed to download export", e);
      return ResponseEntity.notFound().build();
    }
  }
}
