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
@SuppressWarnings("null")
public class LayerElement {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "layer_id", nullable = false)
  @com.fasterxml.jackson.annotation.JsonIgnore
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Layer layer;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "region_id")
  @com.fasterxml.jackson.annotation.JsonIgnore
  private OcrRegion region;

  @Column(columnDefinition = "TEXT")
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

  @Column(name = "mask_polygon")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private String maskPolygon;

  @com.fasterxml.jackson.annotation.JsonProperty("layerId")
  public UUID getLayerIdSerialized() {
    return layer != null ? layer.getId() : null;
  }

  @com.fasterxml.jackson.annotation.JsonProperty("regionId")
  public UUID getRegionIdSerialized() {
    return region != null ? region.getId() : null;
  }

  @com.fasterxml.jackson.annotation.JsonProperty("qaStatus")
  public String getQaStatusSerialized() {
    if (region == null) return null;
    try {
      return region.getQaStatus();
    } catch (org.hibernate.LazyInitializationException e) {
      return null;
    }
  }

  @com.fasterxml.jackson.annotation.JsonProperty("qaScore")
  public Double getQaScoreSerialized() {
    if (region == null) return null;
    try {
      return region.getQaScore();
    } catch (org.hibernate.LazyInitializationException e) {
      return null;
    }
  }

  @com.fasterxml.jackson.annotation.JsonProperty("qaFeedback")
  public String getQaFeedbackSerialized() {
    if (region == null) return null;
    try {
      return region.getQaFeedback();
    } catch (org.hibernate.LazyInitializationException e) {
      return null;
    }
  }
}
