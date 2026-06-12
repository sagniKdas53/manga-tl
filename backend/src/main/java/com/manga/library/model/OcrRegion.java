package com.manga.library.model;

import jakarta.persistence.*;
import lombok.*;
import java.util.UUID;

@Entity
@Table(name = "ocr_regions")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OcrRegion {
    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "image_id", nullable = false)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private Image image;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "panel_id")
    @com.fasterxml.jackson.annotation.JsonIgnore
    private Panel panel;

    private String text;

    @Column(name = "detected_language", nullable = false)
    private String detectedLanguage;

    private Double confidence;

    @Builder.Default
    private Double rotation = 0.0;

    @Column(name = "bbox_x", nullable = false)
    private Integer bboxX;

    @Column(name = "bbox_y", nullable = false)
    private Integer bboxY;

    @Column(name = "bbox_w", nullable = false)
    private Integer bboxW;

    @Column(name = "bbox_h", nullable = false)
    private Integer bboxH;

    @Column(name = "panel_reading_order")
    private Integer panelReadingOrder;

    @Column(name = "bubble_reading_order")
    private Integer bubbleReadingOrder;
}
