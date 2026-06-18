package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.*;

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
  @com.fasterxml.jackson.annotation.JsonIgnore
  private Layer layer;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "region_id")
  @com.fasterxml.jackson.annotation.JsonIgnore
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

  @Builder.Default private Double rotation = 0.0;

  @Column(nullable = false)
  private Double x;

  @Column(nullable = false)
  private Double y;

  @Builder.Default private Boolean visible = true;

  @Builder.Default private Boolean overflow = false;

  @Column(name = "background_color")
  private String backgroundColor;

  @Column(name = "text_color")
  private String textColor;

  @Column(name = "font_weight")
  @Builder.Default
  private String fontWeight = "normal";

  @Column(name = "font_style")
  @Builder.Default
  private String fontStyle = "normal";

  @Column(name = "is_manually_edited")
  @Builder.Default
  private Boolean isManuallyEdited = false;

  @Column(name = "edited_at")
  private OffsetDateTime editedAt;

  @Column(name = "box_shape")
  @Builder.Default
  private String boxShape = "rectangular";

  @com.fasterxml.jackson.annotation.JsonProperty("layerId")
  public UUID getLayerIdSerialized() {
    return layer != null ? layer.getId() : null;
  }

  @com.fasterxml.jackson.annotation.JsonProperty("regionId")
  public UUID getRegionIdSerialized() {
    return region != null ? region.getId() : null;
  }
}
