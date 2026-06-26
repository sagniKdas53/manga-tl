package com.manga.library.controller;

import com.manga.library.dto.PageDto;
import com.manga.library.dto.UploadResponse;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.MinioService;
import com.manga.library.service.SseService;
import java.util.*;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
@Slf4j
public class PageController {

  private final SeriesRepository seriesRepository;
  private final ChapterRepository chapterRepository;
  private final ImageRepository imageRepository;
  private final PageRepository pageRepository;
  private final PanelRepository panelRepository;
  private final OcrRegionRepository ocrRegionRepository;
  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final MinioService minioService;
  private final JobCoordinatorService jobCoordinatorService;
  private final com.manga.library.service.PageService pageService;
  private final ConversationRepository conversationRepository;
  private final ConversationRegionRepository conversationRegionRepository;
  private final SseService sseService;

  @org.springframework.beans.factory.annotation.Value("${server.servlet.context-path:}")
  private String contextPath;

  private String getImageUrl(UUID imageId) {
    String cleanContext = contextPath == null ? "" : contextPath;
    if (cleanContext.endsWith("/")) {
      cleanContext = cleanContext.substring(0, cleanContext.length() - 1);
    }
    return cleanContext + "/api/images/" + imageId + "/file";
  }

  private byte[] generateThumbnail(byte[] originalBytes) {
    try (java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(originalBytes)) {
      java.awt.image.BufferedImage originalImage = javax.imageio.ImageIO.read(in);
      if (originalImage == null) {
        log.warn("Unsupported image format or failed to read image for thumbnail generation.");
        return null;
      }

      int targetWidth = 300;
      double ratio = (double) originalImage.getHeight() / originalImage.getWidth();
      int targetHeight = (int) (targetWidth * ratio);
      if (targetHeight <= 0) {
        targetHeight = 1;
      }

      java.awt.image.BufferedImage thumbnail =
          new java.awt.image.BufferedImage(
              targetWidth, targetHeight, java.awt.image.BufferedImage.TYPE_INT_RGB);

      java.awt.Graphics2D g = thumbnail.createGraphics();
      g.setRenderingHint(
          java.awt.RenderingHints.KEY_INTERPOLATION,
          java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
      g.drawImage(originalImage, 0, 0, targetWidth, targetHeight, null);
      g.dispose();

      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      javax.imageio.ImageIO.write(thumbnail, "jpg", out);
      return out.toByteArray();
    } catch (Exception e) {
      log.error("Failed to generate thumbnail", e);
      return null;
    }
  }

  @PostMapping("/images")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<UploadResponse> uploadPage(
      @RequestParam("chapterId") UUID chapterId,
      @RequestParam("pageNumber") Integer pageNumber,
      @RequestParam("file") MultipartFile file,
      @AuthenticationPrincipal User user) {

    log.info("Received request to upload page {} for chapter {}", pageNumber, chapterId);

    try {
      Objects.requireNonNull(chapterId, "chapterId cannot be null");
      Chapter chapter =
          chapterRepository
              .findById(chapterId)
              .orElseThrow(() -> new IllegalArgumentException("Chapter not found: " + chapterId));

      // Compute SHA-256 hash of the image
      byte[] originalBytes = file.getBytes();
      java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
      byte[] encodedhash = digest.digest(originalBytes);
      StringBuilder hexString = new StringBuilder(2 * encodedhash.length);
      for (byte b : encodedhash) {
        String hex = Integer.toHexString(0xff & b);
        if (hex.length() == 1) {
          hexString.append('0');
        }
        hexString.append(hex);
      }
      String fileHash = hexString.toString();

      // Check for duplicate image
      Optional<Image> existingImageOpt = imageRepository.findByHash(fileHash);
      if (existingImageOpt.isPresent()) {
        Image existingImage = existingImageOpt.get();
        log.info("Duplicate image detected by hash: {}. Linking to existing image {}", fileHash, existingImage.getId());

        Page page = pageService.createPageWithExistingImage(chapter, existingImage, pageNumber, user);

        // Check if target language layer exists
        String targetLang = chapter.getSeries().getTargetLanguage() != null ? chapter.getSeries().getTargetLanguage().trim().toLowerCase() : "en";
        boolean targetTranslationExists = layerRepository.findByImageId(existingImage.getId()).stream()
            .anyMatch(l -> "translation".equalsIgnoreCase(l.getType()) && targetLang.equalsIgnoreCase(l.getTargetLanguage()));

        if (!targetTranslationExists) {
          log.info("Target translation layer ({}) missing for existing image {}, queuing translation", targetLang, existingImage.getId());
          jobCoordinatorService.triggerImageRedo(existingImage.getId(), "translation");
          sseService.mapImageToUser(existingImage.getId(), user.getId());
        }

        return ResponseEntity.ok(
            new UploadResponse(page.getId(), existingImage.getId(), "duplicate"));
      }

      // Generate unique paths
      String fileExtension = getFileExtension(file.getOriginalFilename());
      String uuid = UUID.randomUUID().toString();
      String storagePath = "originals/" + uuid + fileExtension;

      // Upload file to MinIO (blocking network call, now safely outside DB transaction)
      minioService.uploadFile(storagePath, file);

      // Generate and upload thumbnail
      String thumbnailStoragePath = null;
      try {
        byte[] thumbBytes = generateThumbnail(originalBytes);
        if (thumbBytes != null) {
          thumbnailStoragePath = "thumbnails/" + uuid + ".jpg";
          minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/jpeg");
          log.info("Successfully generated and uploaded thumbnail to {}", thumbnailStoragePath);
        }
      } catch (Exception e) {
        log.error("Failed to generate/upload thumbnail, proceeding without it", e);
      }

      // Call transactional service to save image and page records
      Page page =
          pageService.createPageAndImage(
              chapter,
              file.getOriginalFilename(),
              storagePath,
              thumbnailStoragePath,
              pageNumber,
              fileHash,
              user);

      // Trigger pipeline
      jobCoordinatorService.startPipeline(page.getImage().getId());
      sseService.mapImageToUser(page.getImage().getId(), user.getId());

      return ResponseEntity.ok(
          new UploadResponse(page.getId(), page.getImage().getId(), "processing"));
    } catch (Exception e) {
      log.error("Failed to upload page", e);
      return ResponseEntity.internalServerError().build();
    }
  }

  private String getThumbnailUrl(UUID imageId) {
    String cleanContext = contextPath == null ? "" : contextPath;
    if (cleanContext.endsWith("/")) {
      cleanContext = cleanContext.substring(0, cleanContext.length() - 1);
    }
    return cleanContext + "/api/images/" + imageId + "/thumbnail";
  }

  @GetMapping("/chapters/{chapterId}/pages")
  public ResponseEntity<List<PageDto>> listPages(@PathVariable UUID chapterId) {
    List<PageDto> list =
        pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId).stream()
            .map(
                p -> {
                  PageDto dto = new PageDto();
                  dto.setId(p.getId());
                  dto.setPageNumber(p.getPageNumber());
                  dto.setImageId(p.getImage().getId());
                  dto.setChapterId(p.getChapter().getId());
                  dto.setFilename(p.getImage().getFilename());
                  dto.setUrl(getImageUrl(p.getImage().getId()));
                  dto.setThumbnailUrl(getThumbnailUrl(p.getImage().getId()));
                  return dto;
                })
            .collect(Collectors.toList());
    return ResponseEntity.ok(list);
  }

  @GetMapping("/pages/{pageId}")
  public ResponseEntity<PageDto> getPage(@PathVariable UUID pageId) {
    Objects.requireNonNull(pageId, "pageId cannot be null");
    return pageRepository
        .findById(pageId)
        .map(
            p -> {
              PageDto dto = new PageDto();
              dto.setId(p.getId());
              dto.setPageNumber(p.getPageNumber());
              dto.setImageId(p.getImage().getId());
              dto.setChapterId(p.getChapter().getId());
              dto.setFilename(p.getImage().getFilename());
              dto.setUrl(getImageUrl(p.getImage().getId()));
              dto.setThumbnailUrl(getThumbnailUrl(p.getImage().getId()));
              return ResponseEntity.ok(dto);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @GetMapping("/images/{imageId}")
  public ResponseEntity<Map<String, Object>> getImageDetails(@PathVariable UUID imageId) {
    Objects.requireNonNull(imageId, "imageId cannot be null");
    Image image =
        imageRepository
            .findById(imageId)
            .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    List<Panel> panels = panelRepository.findByImageId(imageId);
    List<OcrRegion> ocrRegions = ocrRegionRepository.findByImageId(imageId);

    // Include conversations with their region mappings
    List<Conversation> conversations = conversationRepository.findByImageId(imageId);
    List<Map<String, Object>> convList = new ArrayList<>();
    for (Conversation conv : conversations) {
      Map<String, Object> convMap = new HashMap<>();
      convMap.put("id", conv.getId().toString());
      convMap.put("sceneType", conv.getSceneType());
      List<ConversationRegion> crs =
          conversationRegionRepository.findByConversationId(conv.getId());
      List<Map<String, Object>> crList = new ArrayList<>();
      for (ConversationRegion cr : crs) {
        Map<String, Object> crMap = new HashMap<>();
        crMap.put("regionId", cr.getRegionId().toString());
        crMap.put("position", cr.getPosition());
        crList.add(crMap);
      }
      convMap.put("regions", crList);
      convList.add(convMap);
    }

    Map<String, Object> response = new HashMap<>();
    response.put("image", image);
    response.put("url", getImageUrl(image.getId()));
    response.put("panels", panels);
    response.put("ocrRegions", ocrRegions);
    response.put("conversations", convList);

    return ResponseEntity.ok(response);
  }

  @GetMapping("/images/{imageId}/file")
  public ResponseEntity<org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody>
      getImageFile(@PathVariable UUID imageId) {
    try {
      Objects.requireNonNull(imageId, "imageId cannot be null");
      Image image =
          imageRepository
              .findById(imageId)
              .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

      String contentType = "image/png";
      String filename = image.getFilename().toLowerCase();
      if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
        contentType = "image/jpeg";
      } else if (filename.endsWith(".webp")) {
        contentType = "image/webp";
      } else if (filename.endsWith(".gif")) {
        contentType = "image/gif";
      }

      String finalContentType = contentType;
      org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody responseBody =
          outputStream -> {
            try (java.io.InputStream is = minioService.getFileStream(image.getStoragePath())) {
              is.transferTo(outputStream);
            } catch (Exception e) {
              log.error("Error streaming image file", e);
            }
          };

      return ResponseEntity.ok()
          .contentType(org.springframework.http.MediaType.parseMediaType(finalContentType))
          .body(responseBody);
    } catch (Exception e) {
      log.error("Failed to retrieve image file for {}", imageId, e);
      return ResponseEntity.notFound().build();
    }
  }

  @GetMapping("/images/{imageId}/thumbnail")
  public ResponseEntity<org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody>
      getImageThumbnail(@PathVariable UUID imageId) {
    try {
      Objects.requireNonNull(imageId, "imageId cannot be null");
      Image image =
          imageRepository
              .findById(imageId)
              .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

      String storagePath = image.getThumbnailStoragePath();
      String contentType = "image/jpeg"; // generated thumbnails are always JPEG

      if (storagePath == null || storagePath.trim().isEmpty()) {
        // Fall back to original file if no thumbnail exists
        storagePath = image.getStoragePath();
        String filename = image.getFilename().toLowerCase();
        contentType = "image/png";
        if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
          contentType = "image/jpeg";
        } else if (filename.endsWith(".webp")) {
          contentType = "image/webp";
        } else if (filename.endsWith(".gif")) {
          contentType = "image/gif";
        }
      }

      String finalStoragePath = storagePath;
      String finalContentType = contentType;
      org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody responseBody =
          outputStream -> {
            try (java.io.InputStream is = minioService.getFileStream(finalStoragePath)) {
              is.transferTo(outputStream);
            } catch (Exception e) {
              log.error("Error streaming image thumbnail", e);
            }
          };

      return ResponseEntity.ok()
          .contentType(org.springframework.http.MediaType.parseMediaType(finalContentType))
          .body(responseBody);
    } catch (Exception e) {
      log.error("Failed to retrieve image thumbnail for {}", imageId, e);
      return ResponseEntity.notFound().build();
    }
  }

  @GetMapping("/images/{imageId}/layers")
  @Transactional
  public ResponseEntity<List<Map<String, Object>>> getImageLayers(@PathVariable UUID imageId) {
    List<Layer> layers = new ArrayList<>(layerRepository.findByImageId(imageId));
    layers.sort(Comparator.comparingInt(Layer::getZOrder));

    // Auto-initialize default translation layer if it doesn't exist but we have translations
    boolean hasTranslationLayer = layers.stream().anyMatch(l -> "translation".equals(l.getType()));
    if (!hasTranslationLayer) {
      List<OcrRegion> ocrRegions = ocrRegionRepository.findByImageId(imageId);
      boolean hasTranslations =
          ocrRegions.stream()
              .anyMatch(
                  r -> r.getTranslatedText() != null && !r.getTranslatedText().trim().isEmpty());

      if (hasTranslations) {
        log.info("Auto-initializing default translation layer for image {}", imageId);
        Objects.requireNonNull(imageId, "imageId cannot be null");
        Image image =
            imageRepository
                .findById(imageId)
                .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

        UUID seriesId =
            pageRepository
                .findByImageId(imageId)
                .map(Page::getChapter)
                .map(Chapter::getSeries)
                .map(Series::getId)
                .orElse(null);
        String targetLang = "en";
        if (seriesId != null) {
          targetLang =
              seriesRepository.findById(seriesId).map(Series::getTargetLanguage).orElse("en");
        }

        Layer defaultLayer =
            Layer.builder()
                .image(image)
                .type("translation")
                .targetLanguage(targetLang)
                .visible(true)
                .zOrder(2)
                .build();

        Objects.requireNonNull(defaultLayer, "defaultLayer cannot be null");
        defaultLayer = layerRepository.save(defaultLayer);
        layers.add(defaultLayer);

        for (OcrRegion region : ocrRegions) {
          if (region.getTranslatedText() != null && !region.getTranslatedText().trim().isEmpty()) {
            LayerElement element =
                LayerElement.builder()
                    .layer(defaultLayer)
                    .region(region)
                    .text(region.getTranslatedText())
                    .x(region.getBboxX().doubleValue())
                    .y(region.getBboxY().doubleValue())
                    .maxWidth(region.getBboxW())
                    .maxHeight(region.getBboxH())
                    .visible(true)
                    .autoSize(true)
                    .build();
            Objects.requireNonNull(element, "element cannot be null");
            layerElementRepository.save(element);
          }
        }
      }
    }

    List<LayerElement> allElements = layerElementRepository.findByLayerImageId(imageId);
    Map<UUID, List<LayerElement>> elementsByLayer =
        allElements.stream().collect(Collectors.groupingBy(le -> le.getLayer().getId()));

    List<Map<String, Object>> response = new ArrayList<>();
    for (Layer l : layers) {
      Map<String, Object> map = new HashMap<>();
      map.put("layer", l);
      map.put("elements", elementsByLayer.getOrDefault(l.getId(), Collections.emptyList()));
      response.add(map);
    }

    return ResponseEntity.ok(response);
  }

  @DeleteMapping("/pages/{pageId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasRole('ADMIN')")
  public ResponseEntity<?> deletePage(@PathVariable UUID pageId) {
    log.info("Received request to delete page: {}", pageId);
    try {
      // Delete from database within transaction
      List<String> pathsToDelete = pageService.deletePageDb(pageId);

      // Delete from MinIO outside transaction (non-blocking)
      for (String storagePath : pathsToDelete) {
        minioService.deleteFile(storagePath);
      }

      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Failed to delete page", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PutMapping("/chapters/{chapterId}/pages/reorder")
  @Transactional
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<?> reorderPages(
      @PathVariable UUID chapterId, @RequestBody List<UUID> pageIds) {
    log.info("Received request to reorder pages for chapter {}: {}", chapterId, pageIds);
    try {
      List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
      Map<UUID, Page> pageMap = pages.stream().collect(Collectors.toMap(Page::getId, p -> p));

      if (pageIds.size() != pages.size() || !pageMap.keySet().containsAll(pageIds)) {
        return ResponseEntity.badRequest().body("Invalid list of page IDs for reordering");
      }

      // Phase 1: Set temporary high page numbers to avoid unique constraint violations
      for (int i = 0; i < pageIds.size(); i++) {
        Page p = pageMap.get(pageIds.get(i));
        p.setPageNumber(i + 1 + 10000);
        pageRepository.save(p);
      }
      pageRepository.flush();

      // Phase 2: Set final sequence numbers
      for (int i = 0; i < pageIds.size(); i++) {
        Page p = pageMap.get(pageIds.get(i));
        p.setPageNumber(i + 1);
        pageRepository.save(p);
      }
      pageRepository.flush();

      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Failed to reorder pages", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PutMapping("/ocr-regions/{id}")
  @Transactional
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<?> updateOcrRegion(
      @PathVariable UUID id, @RequestBody Map<String, Object> payload) {
    Objects.requireNonNull(id, "id cannot be null");
    log.info("Updating OCR region {}: {}", id, payload);
    return ocrRegionRepository
        .findById(id)
        .map(
            region -> {
              if (payload.containsKey("text")) {
                region.setText((String) payload.get("text"));
              }
              if (payload.containsKey("translatedText")) {
                region.setTranslatedText((String) payload.get("translatedText"));
                region.setTranslationFailed(false);
              }
              if (payload.containsKey("approved")) {
                region.setApproved((Boolean) payload.get("approved"));
              }
              if (payload.containsKey("confidence")) {
                region.setConfidence(((Number) payload.get("confidence")).doubleValue());
              }
              Objects.requireNonNull(region, "region cannot be null");
              ocrRegionRepository.save(region);
              return ResponseEntity.ok(region);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/ocr-regions/{id}/redo")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<?> redoOcrRegion(@PathVariable UUID id, @RequestParam("type") String type, @AuthenticationPrincipal User user) {
    log.info("Request to redo OCR region {} with type {}", id, type);
    try {
      jobCoordinatorService.triggerRedo(id, type);
      
      // Look up image ID to map it to the user
      ocrRegionRepository.findById(id).ifPresent(region -> {
        sseService.mapImageToUser(region.getImage().getId(), user.getId());
      });
      
      return ResponseEntity.ok(Map.of("status", "enqueued"));
    } catch (Exception e) {
      log.error("Failed to trigger region redo", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/images/{imageId}/redo")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<?> redoImage(
      @PathVariable UUID imageId, @RequestParam("type") String type, @AuthenticationPrincipal User user) {
    log.info("Request to redo image {} with type {}", imageId, type);
    try {
      if ("ocr".equals(type) || "translation".equals(type) || "layout".equals(type)) {
        jobCoordinatorService.triggerImageRedo(imageId, type);
        sseService.mapImageToUser(imageId, user.getId());
        return ResponseEntity.ok(Map.of("status", "enqueued"));
      } else {
        return ResponseEntity.badRequest().body("Invalid redo type");
      }
    } catch (Exception e) {
      log.error("Failed to trigger image redo", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  private String getFileExtension(String filename) {
    if (filename == null) return ".jpg";
    int lastIndex = filename.lastIndexOf('.');
    return lastIndex == -1 ? ".jpg" : filename.substring(lastIndex);
  }
}
