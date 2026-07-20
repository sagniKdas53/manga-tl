package com.manga.library.service;

import com.manga.library.model.*;
import com.manga.library.repository.*;
import io.minio.errors.MinioException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Slf4j
public class ChapterExportService {

  private final ChapterRepository chapterRepository;
  private final PageRepository pageRepository;
  private final MinioService minioService;
  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final SseService sseService;

  @Transactional(readOnly = true)
  public void buildAndUploadExport(UUID chapterId, UUID userId, boolean force) {
    try {
      Chapter chapter =
          chapterRepository
              .findById(Objects.requireNonNull(chapterId))
              .orElseThrow(() -> new IllegalArgumentException("Chapter not found: " + chapterId));

      List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
      if (pages == null || pages.isEmpty()) {
        throw new IllegalStateException("No pages in chapter");
      }

      List<Map<String, Object>> pageMetadataList = new ArrayList<>();
      double chapterTotalCostVal = 0.0;
      boolean chapterHasCost = false;

      for (int i = 0; i < pages.size(); i++) {
        Page page = pages.get(i);
        UUID imageId = page.getImage().getId();
        String filename = page.getImage().getFilename();
        if (filename == null || filename.trim().isEmpty()) {
          filename = "page_" + page.getPageNumber() + ".png";
        }

        boolean hasRendered = minioService.fileExists("rendered/" + imageId + ".png");

        Map<String, Object> pageMeta = new HashMap<>();
        pageMeta.put("pageNumber", page.getPageNumber());
        pageMeta.put("imageId", imageId.toString());
        pageMeta.put("originalFilename", filename);
        pageMeta.put("hasRendered", hasRendered);

        List<Layer> imageLayers = layerRepository.findByImageId(imageId);
        pageMeta.put("layerCount", imageLayers.size());

        List<Map<String, Object>> layersMetaList = new ArrayList<>();
        double pageTotalCostVal = 0.0;
        boolean pageHasCost = false;
        Map<String, Set<String>> modelsUsed = new HashMap<>();
        modelsUsed.put("ocr", new HashSet<>());
        modelsUsed.put("translation", new HashSet<>());
        modelsUsed.put("qa", new HashSet<>());

        for (Layer l : imageLayers) {
          Map<String, Object> layerMeta = new HashMap<>();
          layerMeta.put("id", l.getId().toString());
          layerMeta.put("type", l.getType());
          layerMeta.put("visible", l.getVisible() == null || l.getVisible());
          if (l.getTargetLanguage() != null) {
            layerMeta.put("targetLanguage", l.getTargetLanguage());
          }
          if (l.getMetadataJson() != null) {
            layerMeta.put("metadataJson", l.getMetadataJson());
          }
          List<LayerElement> elements = layerElementRepository.findByLayerId(l.getId());
          if (elements != null) {
            layerMeta.put("elements", elements);
          }

          String modelName;

          if (l.getMetadataJson() != null && l.getMetadataJson().isObject()) {
            com.fasterxml.jackson.databind.node.ObjectNode metaNode =
                (com.fasterxml.jackson.databind.node.ObjectNode) l.getMetadataJson();

            Set<String> typeModels =
                modelsUsed.computeIfAbsent(l.getType().toLowerCase(), k -> new HashSet<>());

            if (metaNode.has("model")) {
              modelName = metaNode.get("model").asText();
              layerMeta.put("model", modelName);
              typeModels.add(modelName);
            }

            final double[] accumulatedCost = {0.0};
            final boolean[] costFound = {false};

            java.util.function.BiConsumer<com.fasterxml.jackson.databind.JsonNode, Set<String>>
                extractCostAndModels =
                    (costNode, targetSet) -> {
                      if (costNode == null || !costNode.isObject()) return;
                      if (costNode.has("estimated_cost")) {
                        costFound[0] = true;
                        accumulatedCost[0] += costNode.get("estimated_cost").asDouble();
                      }
                      if (costNode.has("breakdown") && costNode.get("breakdown").isArray()) {
                        for (com.fasterxml.jackson.databind.JsonNode item :
                            costNode.get("breakdown")) {
                          if (item.has("model")) targetSet.add(item.get("model").asText());
                          if (item.has("model_identifier"))
                            targetSet.add(item.get("model_identifier").asText());
                        }
                      }
                    };

            if (metaNode.has("cost")) {
              extractCostAndModels.accept(metaNode.get("cost"), typeModels);
            }

            if (metaNode.has("qa") && metaNode.get("qa").has("cost")) {
              extractCostAndModels.accept(metaNode.get("qa").get("cost"), modelsUsed.get("qa"));
            }

            if (metaNode.has("tl") && metaNode.get("tl").has("cost")) {
              extractCostAndModels.accept(
                  metaNode.get("tl").get("cost"), modelsUsed.get("translation"));
            }

            if (costFound[0]) {
              layerMeta.put("estimated_cost", accumulatedCost[0]);
              pageTotalCostVal += accumulatedCost[0];
              pageHasCost = true;
            }
          }

          layersMetaList.add(layerMeta);
        }

        pageMeta.put("layers", layersMetaList);
        pageMeta.put("modelsUsed", modelsUsed);

        if (pageHasCost) {
          Map<String, Object> pageCostMap = new HashMap<>();
          pageCostMap.put("estimated_cost", pageTotalCostVal);
          pageCostMap.put("display", formatCost(pageTotalCostVal));
          pageCostMap.put("currency", "USD");
          pageMeta.put("totalCost", pageCostMap);

          chapterTotalCostVal += pageTotalCostVal;
          chapterHasCost = true;
        } else {
          Map<String, Object> pageCostMap = new HashMap<>();
          pageCostMap.put("estimated_cost", 0.0);
          pageCostMap.put("display", "$0.00");
          pageCostMap.put("currency", "USD");
          pageMeta.put("totalCost", pageCostMap);
        }

        Layer activeLayer = null;
        for (Layer l : imageLayers) {
          if ("translation".equalsIgnoreCase(l.getType()) && Boolean.TRUE.equals(l.getVisible())) {
            activeLayer = l;
            break;
          }
        }

        if (activeLayer != null) {
          Map<String, Object> activeLayerMeta = new HashMap<>();
          activeLayerMeta.put("id", activeLayer.getId().toString());
          activeLayerMeta.put("type", activeLayer.getType());
          activeLayerMeta.put("language", activeLayer.getTargetLanguage());
          pageMeta.put("activeLayer", activeLayerMeta);

          boolean manualQaNeeded = false;
          if (activeLayer.getMetadataJson() != null && activeLayer.getMetadataJson().isObject()) {
            com.fasterxml.jackson.databind.node.ObjectNode metaNode =
                (com.fasterxml.jackson.databind.node.ObjectNode) activeLayer.getMetadataJson();
            if (metaNode.has("qa") && metaNode.get("qa").has("status")) {
              String qaStatus = metaNode.get("qa").get("status").asText();
              manualQaNeeded = "manual_review".equalsIgnoreCase(qaStatus);
            }
          }
          pageMeta.put("manualQaNeeded", manualQaNeeded);

          if (page.getImage() != null) {
            boolean manualChangesDone = false;
            List<LayerElement> allElementsForImage =
                layerElementRepository.findByLayerImageId(page.getImage().getId());
            for (LayerElement el : allElementsForImage) {
              if (el.getIsManuallyEdited() != null && el.getIsManuallyEdited()) {
                manualChangesDone = true;
                break;
              }
            }

            boolean needsReRender = false;
            if (manualChangesDone) {
              java.time.OffsetDateTime lastEditedAt = page.getImage().getLastEditedAt();
              java.time.OffsetDateTime lastRenderedAt = page.getImage().getLastRenderedAt();
              if (lastEditedAt != null
                  && (lastRenderedAt == null || lastEditedAt.isAfter(lastRenderedAt))) {
                needsReRender = true;
              }
            }
            pageMeta.put("manualChangesDone", manualChangesDone);
            pageMeta.put("needsReRender", needsReRender);
          } else {
            pageMeta.put("manualChangesDone", false);
            pageMeta.put("needsReRender", false);
          }
        } else {
          pageMeta.put("manualChangesDone", false);
          pageMeta.put("needsReRender", false);
          pageMeta.put("manualQaNeeded", false);
        }

        pageMetadataList.add(pageMeta);
      }

      Map<String, Object> chapterMeta = new LinkedHashMap<>();
      chapterMeta.put("totalPages", pages.size());
      chapterMeta.put("chapterNumber", chapter.getChapterNumber());
      chapterMeta.put("chapterTitle", chapter.getTitle());
      if (chapter.getSeries() != null) {
        chapterMeta.put("seriesTitle", chapter.getSeries().getTitle());
      }

      if (chapterHasCost) {
        Map<String, Object> chCostMap = new HashMap<>();
        chCostMap.put("estimated_cost", chapterTotalCostVal);
        chCostMap.put("display", formatCost(chapterTotalCostVal));
        chCostMap.put("currency", "USD");
        chapterMeta.put("totalCost", chCostMap);
      }

      chapterMeta.put("pages", pageMetadataList);

      com.fasterxml.jackson.databind.ObjectMapper mapper =
          new com.fasterxml.jackson.databind.ObjectMapper();
      mapper.registerModule(new com.fasterxml.jackson.datatype.jsr310.JavaTimeModule());
      byte[] hashBytes = mapper.writeValueAsBytes(chapterMeta);
      java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
      byte[] encodedhash = digest.digest(hashBytes);
      StringBuilder hexString = new StringBuilder(2 * encodedhash.length);
      for (byte b : encodedhash) {
        String hex = Integer.toHexString(0xff & b);
        if (hex.length() == 1) {
          hexString.append('0');
        }
        hexString.append(hex);
      }
      String hashExportId = chapterId.toString() + "_" + hexString.toString();

      String seriesTitle =
          chapter.getSeries() != null ? chapter.getSeries().getTitle() : "Unknown Series";
      Map<String, String> ctx = new HashMap<>();
      ctx.put("exportId", hashExportId);
      ctx.put("seriesTitle", seriesTitle);
      ctx.put("chapterNumber", String.valueOf(chapter.getChapterNumber()));
      if (chapter.getTitle() != null) {
        ctx.put("chapterTitle", chapter.getTitle());
      }

      if (!force && minioService.fileExists("exports/" + hashExportId + ".zip")) {
        log.info("Cache hit for export ZIP: " + hashExportId);
        if (userId != null) {
          sseService.emitNotificationToUser(
              userId,
              "EXPORT_SUCCESS",
              "Export Ready",
              "Your chapter export is ready for download.",
              null,
              ctx);
        }
        return;
      }

      chapterMeta.put("exportTimestamp", java.time.OffsetDateTime.now().toString());
      byte[] jsonBytes = mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(chapterMeta);

      try (ByteArrayOutputStream baos = new ByteArrayOutputStream();
          ZipOutputStream zos = new ZipOutputStream(baos)) {
        for (int i = 0; i < pages.size(); i++) {
          Page page = pages.get(i);
          UUID imageId = page.getImage().getId();
          String filename = page.getImage().getFilename();
          if (filename == null || filename.trim().isEmpty()) {
            filename = "page_" + page.getPageNumber() + ".png";
          }

          byte[] imageBytes = null;
          try (java.io.InputStream is = minioService.downloadFile("rendered/" + imageId + ".png")) {
            imageBytes = is.readAllBytes();
          } catch (RuntimeException | IOException | MinioException e) {
            try (java.io.InputStream is =
                minioService.downloadFile(page.getImage().getStoragePath())) {
              imageBytes = is.readAllBytes();
            } catch (RuntimeException | IOException | MinioException ex) {
              log.error("Failed to download original/rendered image for page " + page.getId(), ex);
            }
          }

          if (imageBytes != null) {
            String ext = "png";
            if (filename.contains(".")) {
              ext = filename.substring(filename.lastIndexOf('.') + 1);
            }
            String zipEntryName = String.format("%03d.%s", page.getPageNumber(), ext);
            zos.putNextEntry(new ZipEntry(zipEntryName));
            zos.write(imageBytes);
            zos.closeEntry();
          }
        }

        zos.putNextEntry(new ZipEntry("meta-data.json"));
        zos.write(jsonBytes);
        zos.closeEntry();
        zos.finish();
        byte[] zipBytes = baos.toByteArray();

        minioService.uploadFile("exports/" + hashExportId + ".zip", zipBytes, "application/zip");

        if (userId != null) {
          sseService.emitNotificationToUser(
              userId,
              "EXPORT_SUCCESS",
              "Export Ready",
              "Your chapter export is ready for download.",
              null,
              ctx);
        }
      }
    } catch (RuntimeException | IOException | NoSuchAlgorithmException | MinioException e) {
      log.error("Failed to build export for chapter: " + chapterId, e);
      if (userId != null) {
        sseService.emitNotificationToUser(
            userId,
            "EXPORT_ERROR",
            "Export Failed",
            "Failed to generate chapter export: " + e.getMessage());
      }
    }
  }

  private String formatCost(double cost) {
    if (cost < 0.0001 && cost > 0) {
      return "< $0.0001";
    }
    return String.format("$%.4f", cost);
  }

  @Transactional
  public void clearChapterExports(UUID chapterId) {
    try {
      Iterable<io.minio.Result<io.minio.messages.Item>> results =
          minioService.listObjects("exports/" + chapterId.toString() + "_");
      for (io.minio.Result<io.minio.messages.Item> result : results) {
        io.minio.messages.Item item = result.get();
        minioService.deleteFile(item.objectName());
      }
    } catch (Exception e) {
      log.error("Failed to clear chapter exports", e);
    }
  }

  @org.springframework.scheduling.annotation.Scheduled(fixedRate = 86400000) // Run daily
  public void cleanupStaleExports() {
    log.info("Running scheduled cleanup for stale exports in MinIO...");
    try {
      Iterable<io.minio.Result<io.minio.messages.Item>> results =
          minioService.listObjects("exports/");
      
      java.time.ZonedDateTime threshold = java.time.ZonedDateTime.now().minusDays(7);
      int deletedCount = 0;

      for (io.minio.Result<io.minio.messages.Item> result : results) {
        io.minio.messages.Item item = result.get();
        if (item.lastModified().isBefore(threshold)) {
          minioService.deleteFile(item.objectName());
          deletedCount++;
        }
      }
      log.info("Successfully deleted {} stale exports older than 7 days.", deletedCount);
    } catch (Exception e) {
      log.error("Failed to cleanup stale exports", e);
    }
  }
}
