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
            dto.setFilename(p.getImage().getFilename());
            dto.setUrl(minioService.generatePresignedUrl(p.getImage().getStoragePath()));
            return dto;
        }).collect(Collectors.toList());
        return ResponseEntity.ok(list);
    }

    @GetMapping("/images/{imageId}")
    public ResponseEntity<Map<String, Object>> getImageDetails(@PathVariable UUID imageId) {
        Image image = imageRepository.findById(imageId)
                .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

        List<Panel> panels = panelRepository.findByImageId(imageId);
        List<OcrRegion> ocrRegions = ocrRegionRepository.findByImageId(imageId);

        Map<String, Object> response = new HashMap<>();
        response.put("image", image);
        response.put("url", minioService.generatePresignedUrl(image.getStoragePath()));
        response.put("panels", panels);
        response.put("ocrRegions", ocrRegions);

        return ResponseEntity.ok(response);
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

    private String getFileExtension(String filename) {
        if (filename == null) return ".jpg";
        int lastIndex = filename.lastIndexOf('.');
        return lastIndex == -1 ? ".jpg" : filename.substring(lastIndex);
    }
}
