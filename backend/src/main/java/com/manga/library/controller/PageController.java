package com.manga.library.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
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
  private final LayerEditHistoryRepository layerEditHistoryRepository;
  private final ObjectMapper objectMapper;

  @org.springframework.beans.factory.annotation.Value("${server.servlet.context-path:}")
  private String contextPath;

  private String getImageUrl(UUID imageId) {
    String cleanContext = contextPath == null ? "" : contextPath;
    if (cleanContext.endsWith("/")) {
      cleanContext = cleanContext.substring(0, cleanContext.length() - 1);
    }
    return cleanContext + "/api/images/" + imageId + "/file";
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

      String originalFilename = file.getOriginalFilename();
      String fileExtension = pageService.getFileExtension(originalFilename);

      if (".zip".equalsIgnoreCase(fileExtension) || ".epub".equalsIgnoreCase(fileExtension)) {
        // 1. Process as ZIP/ePub
        byte[] projectJsonBytes = null;
        byte[] originalImageBytes = null;
        String originalImageFilename = null;
        java.util.List<com.manga.library.dto.ZipImageEntry> imageEntries =
            new java.util.ArrayList<>();

        try (java.util.zip.ZipInputStream zis =
            new java.util.zip.ZipInputStream(file.getInputStream())) {
          java.util.zip.ZipEntry entry;
          while ((entry = zis.getNextEntry()) != null) {
            if (entry.isDirectory()) continue;
            String name = entry.getName();
            String lowerName = name.toLowerCase();
            if (lowerName.contains("__macosx")
                || lowerName.contains("/.")
                || name.startsWith(".")) {
              continue;
            }

            if ("project.json".equals(name) || lowerName.endsWith("project.json")) {
              java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
              byte[] buffer = new byte[4096];
              int len;
              while ((len = zis.read(buffer)) > -1) {
                baos.write(buffer, 0, len);
              }
              projectJsonBytes = baos.toByteArray();
            } else if (lowerName.endsWith(".png")
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
              byte[] bytes = baos.toByteArray();
              imageEntries.add(new com.manga.library.dto.ZipImageEntry(name, bytes));

              if ("original.png".equals(name)
                  || lowerName.contains("original")
                  || originalImageBytes == null) {
                originalImageBytes = bytes;
                originalImageFilename = name;
              }
            }
          }
        }

        if (projectJsonBytes != null) {
          // Case A: Page-level project ZIP restore
          if (originalImageBytes == null && !imageEntries.isEmpty()) {
            imageEntries.sort(Comparator.comparing(com.manga.library.dto.ZipImageEntry::getName));
            originalImageBytes = imageEntries.get(0).getBytes();
            originalImageFilename = imageEntries.get(0).getName();
          }

          if (originalImageBytes == null) {
            return ResponseEntity.badRequest()
                .body(
                    new UploadResponse(
                        null, null, "error: project.json found but no image found in zip"));
          }

          if (originalImageFilename == null) {
            originalImageFilename = "original.png";
          }

          java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
          byte[] encodedhash = digest.digest(originalImageBytes);
          StringBuilder hexString = new StringBuilder(2 * encodedhash.length);
          for (byte b : encodedhash) {
            String hex = Integer.toHexString(0xff & b);
            if (hex.length() == 1) hexString.append('0');
            hexString.append(hex);
          }
          String fileHash = hexString.toString();

          // Check duplicate image
          Optional<Image> existingImageOpt = imageRepository.findByHash(fileHash);
          Optional<Page> existingPageOpt =
              pageRepository.findByChapterIdAndPageNumber(chapter.getId(), pageNumber);
          Page page;
          if (existingPageOpt.isPresent()) {
            page = existingPageOpt.get();
            Image oldImage = page.getImage();

            // Clear existing elements and layers
            List<LayerElement> elements = layerElementRepository.findByLayerImageId(oldImage.getId());
            for (LayerElement el : elements) {
              List<LayerEditHistory> history =
                  layerEditHistoryRepository.findByLayerElementIdOrderByEditedAtDesc(el.getId());
              layerEditHistoryRepository.deleteAll(history);
              layerElementRepository.delete(el);
            }
            layerElementRepository.flush();

            List<Layer> existingLayers = layerRepository.findByImageId(oldImage.getId());
            for (Layer l : existingLayers) {
              layerRepository.delete(l);
            }
            layerRepository.flush();

            // Check if we need to update/replace the image
            if (!fileHash.equals(oldImage.getHash())) {
              Image image;
              if (existingImageOpt.isPresent()) {
                image = existingImageOpt.get();
              } else {
                String uuid = UUID.randomUUID().toString();
                String imgExt = pageService.getFileExtension(originalImageFilename);
                String storagePath = "originals/" + uuid + imgExt;
                String contentType = "image/png";
                if (imgExt.equalsIgnoreCase(".jpg") || imgExt.equalsIgnoreCase(".jpeg")) {
                  contentType = "image/jpeg";
                } else if (imgExt.equalsIgnoreCase(".webp")) {
                  contentType = "image/webp";
                } else if (imgExt.equalsIgnoreCase(".gif")) {
                  contentType = "image/gif";
                }

                minioService.uploadFile(storagePath, originalImageBytes, contentType);

                String thumbnailStoragePath = null;
                try {
                  byte[] thumbBytes = pageService.generateThumbnail(originalImageBytes);
                  if (thumbBytes != null) {
                    thumbnailStoragePath = "thumbnails/" + uuid + ".jpg";
                    minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/jpeg");
                  }
                } catch (Exception e) {
                  log.error("Failed to generate/upload thumbnail in ZIP import", e);
                }

                image = Image.builder()
                    .filename(originalImageFilename)
                    .storagePath(storagePath)
                    .thumbnailStoragePath(thumbnailStoragePath)
                    .hash(fileHash)
                    .createdBy(user)
                    .build();
                image = imageRepository.save(image);
              }
              page.setImage(image);
              page = pageRepository.save(page);
            }
          } else {
            if (existingImageOpt.isPresent()) {
              Image existingImage = existingImageOpt.get();
              page =
                  pageService.createPageWithExistingImage(chapter, existingImage, pageNumber, user);
            } else {
              String uuid = UUID.randomUUID().toString();
              String imgExt = pageService.getFileExtension(originalImageFilename);
              String storagePath = "originals/" + uuid + imgExt;
              String contentType = "image/png";
              if (imgExt.equalsIgnoreCase(".jpg") || imgExt.equalsIgnoreCase(".jpeg")) {
                contentType = "image/jpeg";
              } else if (imgExt.equalsIgnoreCase(".webp")) {
                contentType = "image/webp";
              } else if (imgExt.equalsIgnoreCase(".gif")) {
                contentType = "image/gif";
              }

              minioService.uploadFile(storagePath, originalImageBytes, contentType);

              String thumbnailStoragePath = null;
              try {
                byte[] thumbBytes = pageService.generateThumbnail(originalImageBytes);
                if (thumbBytes != null) {
                  thumbnailStoragePath = "thumbnails/" + uuid + ".jpg";
                  minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/jpeg");
                }
              } catch (Exception e) {
                log.error("Failed to generate/upload thumbnail in ZIP import", e);
              }

              page =
                  pageService.createPageAndImage(
                      chapter,
                      originalImageFilename,
                      storagePath,
                      thumbnailStoragePath,
                      pageNumber,
                      fileHash,
                      user);
            }
          }

          int importedLayersCount = 0;
          int importedElementsCount = 0;

          // Restore layers and elements
          com.fasterxml.jackson.databind.JsonNode root = objectMapper.readTree(projectJsonBytes);
          com.fasterxml.jackson.databind.JsonNode layersNode = root.get("layers");
          if (layersNode != null && layersNode.isArray()) {
            for (com.fasterxml.jackson.databind.JsonNode layerNode : layersNode) {
              String type = layerNode.has("type") ? layerNode.get("type").asText() : "translation";
              String targetLanguage =
                  layerNode.has("targetLanguage") && !layerNode.get("targetLanguage").isNull()
                      ? layerNode.get("targetLanguage").asText()
                      : null;
              boolean visible = !layerNode.has("visible") || layerNode.get("visible").asBoolean();
              int zOrder = layerNode.has("zOrder") ? layerNode.get("zOrder").asInt() : 0;

              Layer newLayer =
                  Layer.builder()
                      .image(page.getImage())
                      .type(type)
                      .targetLanguage(targetLanguage)
                      .visible(visible)
                      .zOrder(zOrder)
                      .build();
              newLayer = layerRepository.save(newLayer);
              importedLayersCount++;

              com.fasterxml.jackson.databind.JsonNode elementsNode = layerNode.get("elements");
              if (elementsNode != null && elementsNode.isArray()) {
                for (com.fasterxml.jackson.databind.JsonNode elNode : elementsNode) {
                  String text = elNode.has("text") ? elNode.get("text").asText() : "";
                  String font = elNode.has("font") ? elNode.get("font").asText() : "Comic Neue";
                  double size = elNode.has("size") ? elNode.get("size").asDouble() : 16.0;
                  boolean autoSize = !elNode.has("autoSize") || elNode.get("autoSize").asBoolean();
                  int maxWidth = elNode.has("maxWidth") ? elNode.get("maxWidth").asInt() : 150;
                  int maxHeight = elNode.has("maxHeight") ? elNode.get("maxHeight").asInt() : 80;
                  boolean wordWrap = !elNode.has("wordWrap") || elNode.get("wordWrap").asBoolean();
                  double rotation =
                      elNode.has("rotation") ? elNode.get("rotation").asDouble() : 0.0;
                  double x = elNode.has("x") ? elNode.get("x").asDouble() : 100.0;
                  double y = elNode.has("y") ? elNode.get("y").asDouble() : 100.0;
                  boolean elVisible = !elNode.has("visible") || elNode.get("visible").asBoolean();
                  String backgroundColor =
                      elNode.has("backgroundColor") && !elNode.get("backgroundColor").isNull()
                          ? elNode.get("backgroundColor").asText()
                          : null;
                  String textColor =
                      elNode.has("textColor") && !elNode.get("textColor").isNull()
                          ? elNode.get("textColor").asText()
                          : null;
                  String fontWeight =
                      elNode.has("fontWeight") ? elNode.get("fontWeight").asText() : "normal";
                  String fontStyle =
                      elNode.has("fontStyle") ? elNode.get("fontStyle").asText() : "normal";
                  String boxShape =
                      elNode.has("boxShape") ? elNode.get("boxShape").asText() : "rectangular";

                  String maskPolygon = null;
                  if (elNode.has("maskPolygon") && !elNode.get("maskPolygon").isNull()) {
                    com.fasterxml.jackson.databind.JsonNode mpNode = elNode.get("maskPolygon");
                    maskPolygon = mpNode.isContainerNode() ? mpNode.toString() : mpNode.asText();
                  }

                  LayerElement newEl =
                      LayerElement.builder()
                          .layer(newLayer)
                          .text(text)
                          .font(font)
                          .size(size)
                          .autoSize(autoSize)
                          .maxWidth(maxWidth)
                          .maxHeight(maxHeight)
                          .wordWrap(wordWrap)
                          .rotation(rotation)
                          .x(x)
                          .y(y)
                          .visible(elVisible)
                          .backgroundColor(backgroundColor)
                          .textColor(textColor)
                          .fontWeight(fontWeight)
                          .fontStyle(fontStyle)
                          .boxShape(boxShape)
                          .maskPolygon(maskPolygon)
                          .build();
                  layerElementRepository.save(newEl);
                  importedElementsCount++;
                }
              }
            }
          }

          log.info("Successfully restored page-level project ZIP: {} layers and {} elements imported.",
              importedLayersCount, importedElementsCount);

          return ResponseEntity.ok(
              new UploadResponse(page.getId(), page.getImage().getId(), "imported"));

        } else {
          // Case B: ZIP/ePub containing multiple images
          if (imageEntries.isEmpty()) {
            return ResponseEntity.badRequest()
                .body(new UploadResponse(null, null, "error: zip contains no images"));
          }

          imageEntries.sort(Comparator.comparing(com.manga.library.dto.ZipImageEntry::getName));

          Page firstPage = null;
          int nextNum = pageNumber;

          for (com.manga.library.dto.ZipImageEntry imgEntry : imageEntries) {
            byte[] originalBytes = imgEntry.getBytes();

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
            Optional<Image> existingImageOpt = imageRepository.findByHash(fileHash);
            if (existingImageOpt.isPresent()) {
              Image existingImage = existingImageOpt.get();
              Page pg =
                  pageService.createPageWithExistingImage(chapter, existingImage, nextNum, user);
              if (firstPage == null) firstPage = pg;

              String targetLang =
                  chapter.getSeries().getTargetLanguage() != null
                      ? chapter.getSeries().getTargetLanguage().trim().toLowerCase()
                      : "en";
              boolean targetTranslationExists =
                  layerRepository.findByImageId(existingImage.getId()).stream()
                      .anyMatch(
                          l ->
                              "translation".equalsIgnoreCase(l.getType())
                                  && targetLang.equalsIgnoreCase(l.getTargetLanguage()));

              if (!targetTranslationExists) {
                jobCoordinatorService.triggerImageRedo(existingImage.getId(), "translation");
              }
              nextNum++;
              continue;
            }

            String uuid = UUID.randomUUID().toString();
            String imgExt = pageService.getFileExtension(imgEntry.getName());
            String storagePath = "originals/" + uuid + imgExt;
            String contentType = "image/png";
            if (imgExt.equalsIgnoreCase(".jpg") || imgExt.equalsIgnoreCase(".jpeg")) {
              contentType = "image/jpeg";
            } else if (imgExt.equalsIgnoreCase(".webp")) {
              contentType = "image/webp";
            } else if (imgExt.equalsIgnoreCase(".gif")) {
              contentType = "image/gif";
            }

            minioService.uploadFile(storagePath, originalBytes, contentType);

            String thumbnailStoragePath = null;
            try {
              byte[] thumbBytes = pageService.generateThumbnail(originalBytes);
              if (thumbBytes != null) {
                thumbnailStoragePath = "thumbnails/" + uuid + ".jpg";
                minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/jpeg");
              }
            } catch (Exception e) {
              log.error("Failed to generate thumbnail for page in zip", e);
            }

            Page pg =
                pageService.createPageAndImage(
                    chapter,
                    imgEntry.getName(),
                    storagePath,
                    thumbnailStoragePath,
                    nextNum,
                    fileHash,
                    user);

            if (firstPage == null) firstPage = pg;

            jobCoordinatorService.startPipeline(pg.getImage().getId());
            nextNum++;
          }

          return ResponseEntity.ok(
              new UploadResponse(firstPage.getId(), firstPage.getImage().getId(), "zip_imported"));
        }
      }

      // 2. Process standard single image upload
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
        log.info(
            "Duplicate image detected by hash: {}. Linking to existing image {}",
            fileHash,
            existingImage.getId());

        Page page =
            pageService.createPageWithExistingImage(chapter, existingImage, pageNumber, user);

        // Check if target language layer exists
        String targetLang =
            chapter.getSeries().getTargetLanguage() != null
                ? chapter.getSeries().getTargetLanguage().trim().toLowerCase()
                : "en";
        boolean targetTranslationExists =
            layerRepository.findByImageId(existingImage.getId()).stream()
                .anyMatch(
                    l ->
                        "translation".equalsIgnoreCase(l.getType())
                            && targetLang.equalsIgnoreCase(l.getTargetLanguage()));

        if (!targetTranslationExists) {
          log.info(
              "Target translation layer ({}) missing for existing image {}, queuing translation",
              targetLang,
              existingImage.getId());
          jobCoordinatorService.triggerImageRedo(existingImage.getId(), "translation");
          sseService.mapImageToUser(existingImage.getId(), user.getId());
        }

        return ResponseEntity.ok(
            new UploadResponse(page.getId(), existingImage.getId(), "duplicate"));
      }

      // Generate unique paths
      String uuid = UUID.randomUUID().toString();
      String storagePath = "originals/" + uuid + fileExtension;

      // Upload file to MinIO
      minioService.uploadFile(storagePath, file);

      // Generate and upload thumbnail
      String thumbnailStoragePath = null;
      try {
        byte[] thumbBytes = pageService.generateThumbnail(originalBytes);
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

    // Auto-initialize default translation layer removed to prevent deleted layers from reappearing

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
  public ResponseEntity<?> redoOcrRegion(
      @PathVariable UUID id,
      @RequestParam("type") String type,
      @AuthenticationPrincipal User user) {
    log.info("Request to redo OCR region {} with type {}", id, type);
    try {
      jobCoordinatorService.triggerRedo(id, type);

      // Look up image ID to map it to the user
      ocrRegionRepository
          .findById(id)
          .ifPresent(
              region -> {
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
      @PathVariable UUID imageId,
      @RequestParam("type") String type,
      @AuthenticationPrincipal User user) {
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

  @PostMapping("/chapters/{chapterId}/import-project")
  @Transactional
  public ResponseEntity<?> importProject(
      @PathVariable UUID chapterId,
      @RequestParam("file") MultipartFile file,
      @AuthenticationPrincipal User user) {
    log.info("Importing project ZIP to chapter {}", chapterId);
    try {
      Chapter chapter =
          chapterRepository
              .findById(chapterId)
              .orElseThrow(() -> new IllegalArgumentException("Chapter not found: " + chapterId));

      byte[] projectJsonBytes = null;
      byte[] originalImageBytes = null;
      String originalImageFilename = null;

      try (java.util.zip.ZipInputStream zis =
          new java.util.zip.ZipInputStream(file.getInputStream())) {
        java.util.zip.ZipEntry entry;
        while ((entry = zis.getNextEntry()) != null) {
          if (entry.isDirectory()) continue;
          String name = entry.getName();
          String lowerName = name.toLowerCase();
          if ("project.json".equals(name) || lowerName.endsWith("project.json")) {
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int len;
            while ((len = zis.read(buffer)) > -1) {
              baos.write(buffer, 0, len);
            }
            projectJsonBytes = baos.toByteArray();
          } else if (lowerName.endsWith(".png")
              || lowerName.endsWith(".jpg")
              || lowerName.endsWith(".jpeg")
              || lowerName.endsWith(".webp")
              || lowerName.endsWith(".gif")) {
            if ("original.png".equals(name)
                || lowerName.contains("original")
                || originalImageBytes == null) {
              java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
              byte[] buffer = new byte[4096];
              int len;
              while ((len = zis.read(buffer)) > -1) {
                baos.write(buffer, 0, len);
              }
              originalImageBytes = baos.toByteArray();
              originalImageFilename = name;
            }
          }
        }
      }

      if (projectJsonBytes == null) {
        return ResponseEntity.badRequest()
            .body(Map.of("message", "Invalid zip: project.json missing"));
      }

      com.fasterxml.jackson.databind.JsonNode root = objectMapper.readTree(projectJsonBytes);
      int pageNumber = root.has("pageNumber") ? root.get("pageNumber").asInt() : 1;

      Optional<Page> existingPageOpt =
          pageRepository.findByChapterIdAndPageNumber(chapterId, pageNumber);
      Page page;
      if (existingPageOpt.isPresent()) {
        page = existingPageOpt.get();
        Image oldImage = page.getImage();

        // Clear existing elements and layers
        List<LayerElement> elements = layerElementRepository.findByLayerImageId(oldImage.getId());
        for (LayerElement el : elements) {
          List<LayerEditHistory> history =
              layerEditHistoryRepository.findByLayerElementIdOrderByEditedAtDesc(el.getId());
          layerEditHistoryRepository.deleteAll(history);
          layerElementRepository.delete(el);
        }
        layerElementRepository.flush();

        List<Layer> existingLayers = layerRepository.findByImageId(oldImage.getId());
        for (Layer l : existingLayers) {
          layerRepository.delete(l);
        }
        layerRepository.flush();

        // Check if we need to update/replace the image
        if (originalImageBytes != null) {
          java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
          byte[] encodedhash = digest.digest(originalImageBytes);
          StringBuilder hexString = new StringBuilder(2 * encodedhash.length);
          for (byte b : encodedhash) {
            String hex = Integer.toHexString(0xff & b);
            if (hex.length() == 1) hexString.append('0');
            hexString.append(hex);
          }
          String fileHash = hexString.toString();

          if (!fileHash.equals(oldImage.getHash())) {
            Optional<Image> existingImageOpt = imageRepository.findByHash(fileHash);
            Image image;
            if (existingImageOpt.isPresent()) {
              image = existingImageOpt.get();
            } else {
              String imgExt = pageService.getFileExtension(originalImageFilename);
              String uuid = UUID.randomUUID().toString();
              String storagePath = "originals/" + uuid + imgExt;
              String contentType = "image/png";
              if (imgExt.equalsIgnoreCase(".jpg") || imgExt.equalsIgnoreCase(".jpeg")) {
                contentType = "image/jpeg";
              } else if (imgExt.equalsIgnoreCase(".webp")) {
                contentType = "image/webp";
              } else if (imgExt.equalsIgnoreCase(".gif")) {
                contentType = "image/gif";
              }

              minioService.uploadFile(storagePath, originalImageBytes, contentType);

              String thumbnailStoragePath = null;
              try {
                byte[] thumbBytes = pageService.generateThumbnail(originalImageBytes);
                if (thumbBytes != null) {
                  thumbnailStoragePath = "thumbnails/" + uuid + ".jpg";
                  minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/jpeg");
                }
              } catch (Exception e) {
                log.error("Failed to generate thumbnail for imported project", e);
              }

              image = Image.builder()
                  .filename(originalImageFilename)
                  .storagePath(storagePath)
                  .thumbnailStoragePath(thumbnailStoragePath)
                  .hash(fileHash)
                  .createdBy(user)
                  .build();
              image = imageRepository.save(image);
            }
            page.setImage(image);
            page = pageRepository.save(page);
          }
        }
      } else {
        if (originalImageBytes == null) {
          return ResponseEntity.badRequest().body(Map.of("message", "original.png missing in zip"));
        }

        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        byte[] encodedhash = digest.digest(originalImageBytes);
        StringBuilder hexString = new StringBuilder(2 * encodedhash.length);
        for (byte b : encodedhash) {
          String hex = Integer.toHexString(0xff & b);
          if (hex.length() == 1) hexString.append('0');
          hexString.append(hex);
        }
        String fileHash = hexString.toString();

        Optional<Image> existingImageOpt = imageRepository.findByHash(fileHash);
        Image image;
        if (existingImageOpt.isPresent()) {
          image = existingImageOpt.get();
          page = pageService.createPageWithExistingImage(chapter, image, pageNumber, user);
        } else {
          String imgExt = pageService.getFileExtension(originalImageFilename);
          String uuid = UUID.randomUUID().toString();
          String storagePath = "originals/" + uuid + imgExt;
          String contentType = "image/png";
          if (imgExt.equalsIgnoreCase(".jpg") || imgExt.equalsIgnoreCase(".jpeg")) {
            contentType = "image/jpeg";
          } else if (imgExt.equalsIgnoreCase(".webp")) {
            contentType = "image/webp";
          } else if (imgExt.equalsIgnoreCase(".gif")) {
            contentType = "image/gif";
          }

          minioService.uploadFile(storagePath, originalImageBytes, contentType);

          String thumbnailStoragePath = null;
          try {
            byte[] thumbBytes = pageService.generateThumbnail(originalImageBytes);
            if (thumbBytes != null) {
              thumbnailStoragePath = "thumbnails/" + uuid + ".jpg";
              minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/jpeg");
            }
          } catch (Exception e) {
            log.error("Failed to generate thumbnail for imported project", e);
          }

          page =
              pageService.createPageAndImage(
                  chapter,
                  originalImageFilename,
                  storagePath,
                  thumbnailStoragePath,
                  pageNumber,
                  fileHash,
                  user);
        }
      }

      int importedLayersCount = 0;
      int importedElementsCount = 0;

      // Restore layers and elements
      Image image = page.getImage();
      com.fasterxml.jackson.databind.JsonNode layersNode = root.get("layers");
      if (layersNode != null && layersNode.isArray()) {
        for (com.fasterxml.jackson.databind.JsonNode layerNode : layersNode) {
          String type = layerNode.has("type") ? layerNode.get("type").asText() : "translation";
          String targetLanguage =
              layerNode.has("targetLanguage") && !layerNode.get("targetLanguage").isNull()
                  ? layerNode.get("targetLanguage").asText()
                  : null;
          boolean visible = !layerNode.has("visible") || layerNode.get("visible").asBoolean();
          int zOrder = layerNode.has("zOrder") ? layerNode.get("zOrder").asInt() : 0;

          Layer newLayer =
              Layer.builder()
                  .image(image)
                  .type(type)
                  .targetLanguage(targetLanguage)
                  .visible(visible)
                  .zOrder(zOrder)
                  .build();
          newLayer = layerRepository.save(newLayer);
          importedLayersCount++;

          com.fasterxml.jackson.databind.JsonNode elementsNode = layerNode.get("elements");
          if (elementsNode != null && elementsNode.isArray()) {
            for (com.fasterxml.jackson.databind.JsonNode elNode : elementsNode) {
              String text = elNode.has("text") ? elNode.get("text").asText() : "";
              String font = elNode.has("font") ? elNode.get("font").asText() : "Comic Neue";
              double size = elNode.has("size") ? elNode.get("size").asDouble() : 16.0;
              boolean autoSize = !elNode.has("autoSize") || elNode.get("autoSize").asBoolean();
              int maxWidth = elNode.has("maxWidth") ? elNode.get("maxWidth").asInt() : 150;
              int maxHeight = elNode.has("maxHeight") ? elNode.get("maxHeight").asInt() : 80;
              boolean wordWrap = !elNode.has("wordWrap") || elNode.get("wordWrap").asBoolean();
              double rotation = elNode.has("rotation") ? elNode.get("rotation").asDouble() : 0.0;
              double x = elNode.has("x") ? elNode.get("x").asDouble() : 100.0;
              double y = elNode.has("y") ? elNode.get("y").asDouble() : 100.0;
              boolean elVisible = !elNode.has("visible") || elNode.get("visible").asBoolean();
              String backgroundColor =
                  elNode.has("backgroundColor") && !elNode.get("backgroundColor").isNull()
                      ? elNode.get("backgroundColor").asText()
                      : null;
              String textColor =
                  elNode.has("textColor") && !elNode.get("textColor").isNull()
                      ? elNode.get("textColor").asText()
                      : null;
              String fontWeight =
                  elNode.has("fontWeight") ? elNode.get("fontWeight").asText() : "normal";
              String fontStyle =
                  elNode.has("fontStyle") ? elNode.get("fontStyle").asText() : "normal";
              String boxShape =
                  elNode.has("boxShape") ? elNode.get("boxShape").asText() : "rectangular";

              String maskPolygon = null;
              if (elNode.has("maskPolygon") && !elNode.get("maskPolygon").isNull()) {
                com.fasterxml.jackson.databind.JsonNode mpNode = elNode.get("maskPolygon");
                maskPolygon = mpNode.isContainerNode() ? mpNode.toString() : mpNode.asText();
              }

              LayerElement newEl =
                  LayerElement.builder()
                      .layer(newLayer)
                      .text(text)
                      .font(font)
                      .size(size)
                      .autoSize(autoSize)
                      .maxWidth(maxWidth)
                      .maxHeight(maxHeight)
                      .wordWrap(wordWrap)
                      .rotation(rotation)
                      .x(x)
                      .y(y)
                      .visible(elVisible)
                      .backgroundColor(backgroundColor)
                      .textColor(textColor)
                      .fontWeight(fontWeight)
                      .fontStyle(fontStyle)
                      .boxShape(boxShape)
                      .maskPolygon(maskPolygon)
                      .build();
              layerElementRepository.save(newEl);
              importedElementsCount++;
            }
          }
        }
      }

      log.info("Successfully imported project ZIP to chapter {}: {} layers and {} elements imported.",
          chapterId, importedLayersCount, importedElementsCount);

      return ResponseEntity.ok(Map.of("status", "success", "pageId", page.getId().toString()));
    } catch (Exception e) {
      log.error("Failed to import project zip", e);
      return ResponseEntity.internalServerError().body(Map.of("message", e.getMessage()));
    }
  }
}
