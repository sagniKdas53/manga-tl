package com.manga.library.controller;

import com.manga.library.dto.PageDto;
import com.manga.library.dto.UploadResponse;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.manga.library.service.MinioService;
import com.manga.library.service.JobCoordinatorService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.util.*;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
@Slf4j
public class PageController {

    private final ChapterRepository chapterRepository;
    private final ImageRepository imageRepository;
    private final PageRepository pageRepository;
    private final PanelRepository panelRepository;
    private final OcrRegionRepository ocrRegionRepository;
    private final LayerRepository layerRepository;
    private final LayerElementRepository layerElementRepository;
    private final MinioService minioService;
    private final JobCoordinatorService jobCoordinatorService;

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
    @Transactional
    public ResponseEntity<UploadResponse> uploadPage(
            @RequestParam("chapterId") UUID chapterId,
            @RequestParam("pageNumber") Integer pageNumber,
            @RequestParam("file") MultipartFile file,
            @AuthenticationPrincipal User user) {

        log.info("Received request to upload page {} for chapter {}", pageNumber, chapterId);

        try {
            Chapter chapter = chapterRepository.findById(chapterId)
                    .orElseThrow(() -> new IllegalArgumentException("Chapter not found: " + chapterId));

            // Generate unique paths
            String fileExtension = getFileExtension(file.getOriginalFilename());
            String uuid = UUID.randomUUID().toString();
            String storagePath = "originals/" + uuid + fileExtension;

            // Upload file to MinIO
            minioService.uploadFile(storagePath, file);

            // Create Image
            Image image = Image.builder()
                    .filename(file.getOriginalFilename())
                    .storagePath(storagePath)
                    .createdBy(user)
                    .build();
            image = imageRepository.save(image);

            // Create Page
            Page page = Page.builder()
                    .chapter(chapter)
                    .pageNumber(pageNumber)
                    .image(image)
                    .build();
            pageRepository.save(page);

            // Trigger pipeline
            jobCoordinatorService.startPipeline(image.getId());

            return ResponseEntity.ok(new UploadResponse(page.getId(), image.getId(), "processing"));
        } catch (Exception e) {
            log.error("Failed to upload page", e);
            return ResponseEntity.internalServerError().build();
        }
    }

    @GetMapping("/chapters/{chapterId}/pages")
    public ResponseEntity<List<PageDto>> listPages(@PathVariable UUID chapterId) {
        List<PageDto> list = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId).stream().map(p -> {
            PageDto dto = new PageDto();
            dto.setId(p.getId());
            dto.setPageNumber(p.getPageNumber());
            dto.setImageId(p.getImage().getId());
            dto.setChapterId(p.getChapter().getId());
            dto.setFilename(p.getImage().getFilename());
            dto.setUrl(getImageUrl(p.getImage().getId()));
            return dto;
        }).collect(Collectors.toList());
        return ResponseEntity.ok(list);
    }

    @GetMapping("/pages/{pageId}")
    public ResponseEntity<PageDto> getPage(@PathVariable UUID pageId) {
        return pageRepository.findById(pageId)
                .map(p -> {
                    PageDto dto = new PageDto();
                    dto.setId(p.getId());
                    dto.setPageNumber(p.getPageNumber());
                    dto.setImageId(p.getImage().getId());
                    dto.setChapterId(p.getChapter().getId());
                    dto.setFilename(p.getImage().getFilename());
                    dto.setUrl(getImageUrl(p.getImage().getId()));
                    return ResponseEntity.ok(dto);
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/images/{imageId}")
    public ResponseEntity<Map<String, Object>> getImageDetails(@PathVariable UUID imageId) {
        Image image = imageRepository.findById(imageId)
                .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

        List<Panel> panels = panelRepository.findByImageId(imageId);
        List<OcrRegion> ocrRegions = ocrRegionRepository.findByImageId(imageId);

        Map<String, Object> response = new HashMap<>();
        response.put("image", image);
        response.put("url", getImageUrl(image.getId()));
        response.put("panels", panels);
        response.put("ocrRegions", ocrRegions);

        return ResponseEntity.ok(response);
    }

    @GetMapping("/images/{imageId}/file")
    public ResponseEntity<org.springframework.core.io.InputStreamResource> getImageFile(@PathVariable UUID imageId) {
        try {
            Image image = imageRepository.findById(imageId)
                    .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));
            
            java.io.InputStream is = minioService.getFileStream(image.getStoragePath());
            
            String contentType = "image/png";
            String filename = image.getFilename().toLowerCase();
            if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
                contentType = "image/jpeg";
            } else if (filename.endsWith(".webp")) {
                contentType = "image/webp";
            } else if (filename.endsWith(".gif")) {
                contentType = "image/gif";
            }
            
            return ResponseEntity.ok()
                    .contentType(org.springframework.http.MediaType.parseMediaType(contentType))
                    .body(new org.springframework.core.io.InputStreamResource(is));
        } catch (Exception e) {
            log.error("Failed to retrieve image file for {}", imageId, e);
            return ResponseEntity.notFound().build();
        }
    }

    @GetMapping("/images/{imageId}/layers")
    public ResponseEntity<List<Map<String, Object>>> getImageLayers(@PathVariable UUID imageId) {
        List<Layer> layers = layerRepository.findByImageId(imageId);
        List<Map<String, Object>> response = new ArrayList<>();

        for (Layer l : layers) {
            List<LayerElement> elements = layerElementRepository.findByLayerId(l.getId());
            Map<String, Object> map = new HashMap<>();
            map.put("layer", l);
            map.put("elements", elements);
            response.add(map);
        }

        return ResponseEntity.ok(response);
    }

    @DeleteMapping("/pages/{pageId}")
    @Transactional
    public ResponseEntity<?> deletePage(@PathVariable UUID pageId) {
        log.info("Received request to delete page: {}", pageId);
        try {
            Page page = pageRepository.findById(pageId)
                    .orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));
            
            Image image = page.getImage();
            UUID chapterId = page.getChapter().getId();

            // 1. Delete page first
            pageRepository.delete(page);
            
            // 2. Delete image (triggers cascade delete in Postgres to panels, OCR, layers, etc.)
            imageRepository.delete(image);
            
            // 3. Flush deletions to DB
            pageRepository.flush();

            // 4. Delete original image file from MinIO
            minioService.deleteFile(image.getStoragePath());

            // 5. Re-sequence remaining pages in chapter to maintain sequence 1..N
            List<Page> remainingPages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
            for (int i = 0; i < remainingPages.size(); i++) {
                remainingPages.get(i).setPageNumber(i + 1);
                pageRepository.save(remainingPages.get(i));
            }
            pageRepository.flush();

            return ResponseEntity.ok().build();
        } catch (Exception e) {
            log.error("Failed to delete page", e);
            return ResponseEntity.internalServerError().body(e.getMessage());
        }
    }

    @PutMapping("/chapters/{chapterId}/pages/reorder")
    @Transactional
    public ResponseEntity<?> reorderPages(@PathVariable UUID chapterId, @RequestBody List<UUID> pageIds) {
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
                p.setPageNumber((i + 1) + 10000);
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
    public ResponseEntity<?> updateOcrRegion(
            @PathVariable UUID id,
            @RequestBody Map<String, Object> payload) {
        log.info("Updating OCR region {}: {}", id, payload);
        return ocrRegionRepository.findById(id)
                .map(region -> {
                    if (payload.containsKey("text")) {
                        region.setText((String) payload.get("text"));
                    }
                    if (payload.containsKey("translatedText")) {
                        region.setTranslatedText((String) payload.get("translatedText"));
                    }
                    if (payload.containsKey("approved")) {
                        region.setApproved((Boolean) payload.get("approved"));
                    }
                    if (payload.containsKey("confidence")) {
                        region.setConfidence(((Number) payload.get("confidence")).doubleValue());
                    }
                    ocrRegionRepository.save(region);
                    return ResponseEntity.ok(region);
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/ocr-regions/{id}/redo")
    public ResponseEntity<?> redoOcrRegion(
            @PathVariable UUID id,
            @RequestParam("type") String type) {
        log.info("Request to redo OCR region {} with type {}", id, type);
        try {
            jobCoordinatorService.triggerRedo(id, type);
            return ResponseEntity.ok(Map.of("status", "enqueued"));
        } catch (Exception e) {
            log.error("Failed to trigger region redo", e);
            return ResponseEntity.internalServerError().body(e.getMessage());
        }
    }


    private String getFileExtension(String filename) {
        if (filename == null) return ".jpg";
        int lastIndex = filename.lastIndexOf('.');
        return lastIndex == -1 ? ".jpg" : filename.substring(lastIndex);
    }
}
