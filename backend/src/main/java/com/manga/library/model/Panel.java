package com.manga.library.model;

import jakarta.persistence.*;
import lombok.*;
import java.util.UUID;

@Entity
@Table(name = "panels")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Panel {
    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "image_id", nullable = false)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private Image image;

    @Column(name = "bbox_x", nullable = false)
    private Integer bboxX;

    @Column(name = "bbox_y", nullable = false)
    private Integer bboxY;

    @Column(name = "bbox_w", nullable = false)
    private Integer bboxW;

    @Column(name = "bbox_h", nullable = false)
    private Integer bboxH;

    @Column(name = "grid_row")
    private Integer gridRow;

    @Column(name = "grid_col")
    private Integer gridCol;

    @Column(name = "reading_order", nullable = false)
    private Integer readingOrder;
}
