package com.manga.library.model;

import jakarta.persistence.*;
import lombok.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "layer_elements")
@Getter
@Setter
@ToString(exclude = {"layer", "region"})
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class LayerElement {
    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    @EqualsAndHashCode.Include
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "layer_id", nullable = false)
    private Layer layer;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "region_id")
    private OcrRegion region;

    private String text;
    private String font;
    private Double size;

    @Column(name = "auto_size")
    @Builder.Default
    private Boolean autoSize = true;

    @Column(name = "max_width")
    private Integer maxWidth;

    @Column(name = "max_height")
    private Integer maxHeight;

    @Column(name = "word_wrap")
    @Builder.Default
    private Boolean wordWrap = true;

    @Builder.Default
    private Double rotation = 0.0;

    @Column(nullable = false)
    private Double x;

    @Column(nullable = false)
    private Double y;

    @Builder.Default
    private Boolean visible = true;

    @Builder.Default
    private Boolean overflow = false;

    @Column(name = "is_manually_edited")
    @Builder.Default
    private Boolean isManuallyEdited = false;

    @Column(name = "edited_at")
    private OffsetDateTime editedAt;
}
