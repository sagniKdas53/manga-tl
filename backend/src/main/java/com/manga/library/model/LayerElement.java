package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "layer_elements")
public class LayerElement {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
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
  
  private Boolean autoSize = true;

  @Column(name = "max_width")
  private Integer maxWidth;

  @Column(name = "max_height")
  private Integer maxHeight;

  @Column(name = "word_wrap")
  
  private Boolean wordWrap = true;

   private Double rotation = 0.0;

  @Column(nullable = false)
  private Double x;

  @Column(nullable = false)
  private Double y;

   private Boolean visible = true;

   private Boolean overflow = false;

  @Column(name = "background_color")
  private String backgroundColor;

  @Column(name = "text_color")
  private String textColor;

  @Column(name = "font_weight")
  
  private String fontWeight = "normal";

  @Column(name = "font_style")
  
  private String fontStyle = "normal";

  @Column(name = "is_manually_edited")
  
  private Boolean isManuallyEdited = false;

  @Column(name = "edited_at")
  private OffsetDateTime editedAt;

  @Column(name = "box_shape")
  
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

  public LayerElement() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public Layer getLayer() {
    return this.layer;
  }

  public void setLayer(Layer layer) {
    this.layer = layer;
  }

  public OcrRegion getRegion() {
    return this.region;
  }

  public void setRegion(OcrRegion region) {
    this.region = region;
  }

  public String getText() {
    return this.text;
  }

  public void setText(String text) {
    this.text = text;
  }

  public String getFont() {
    return this.font;
  }

  public void setFont(String font) {
    this.font = font;
  }

  public Double getSize() {
    return this.size;
  }

  public void setSize(Double size) {
    this.size = size;
  }

  public Boolean getAutoSize() {
    return this.autoSize;
  }

  public void setAutoSize(Boolean autoSize) {
    this.autoSize = autoSize;
  }

  public Integer getMaxWidth() {
    return this.maxWidth;
  }

  public void setMaxWidth(Integer maxWidth) {
    this.maxWidth = maxWidth;
  }

  public Integer getMaxHeight() {
    return this.maxHeight;
  }

  public void setMaxHeight(Integer maxHeight) {
    this.maxHeight = maxHeight;
  }

  public Boolean getWordWrap() {
    return this.wordWrap;
  }

  public void setWordWrap(Boolean wordWrap) {
    this.wordWrap = wordWrap;
  }

  public Double getRotation() {
    return this.rotation;
  }

  public void setRotation(Double rotation) {
    this.rotation = rotation;
  }

  public Double getX() {
    return this.x;
  }

  public void setX(Double x) {
    this.x = x;
  }

  public Double getY() {
    return this.y;
  }

  public void setY(Double y) {
    this.y = y;
  }

  public Boolean getVisible() {
    return this.visible;
  }

  public void setVisible(Boolean visible) {
    this.visible = visible;
  }

  public Boolean getOverflow() {
    return this.overflow;
  }

  public void setOverflow(Boolean overflow) {
    this.overflow = overflow;
  }

  public String getBackgroundColor() {
    return this.backgroundColor;
  }

  public void setBackgroundColor(String backgroundColor) {
    this.backgroundColor = backgroundColor;
  }

  public String getTextColor() {
    return this.textColor;
  }

  public void setTextColor(String textColor) {
    this.textColor = textColor;
  }

  public String getFontWeight() {
    return this.fontWeight;
  }

  public void setFontWeight(String fontWeight) {
    this.fontWeight = fontWeight;
  }

  public String getFontStyle() {
    return this.fontStyle;
  }

  public void setFontStyle(String fontStyle) {
    this.fontStyle = fontStyle;
  }

  public Boolean getIsManuallyEdited() {
    return this.isManuallyEdited;
  }

  public void setIsManuallyEdited(Boolean isManuallyEdited) {
    this.isManuallyEdited = isManuallyEdited;
  }

  public OffsetDateTime getEditedAt() {
    return this.editedAt;
  }

  public void setEditedAt(OffsetDateTime editedAt) {
    this.editedAt = editedAt;
  }

  public String getBoxShape() {
    return this.boxShape;
  }

  public void setBoxShape(String boxShape) {
    this.boxShape = boxShape;
  }

  public String getMaskPolygon() {
    return this.maskPolygon;
  }

  public void setMaskPolygon(String maskPolygon) {
    this.maskPolygon = maskPolygon;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof LayerElement)) return false;
    LayerElement that = (LayerElement) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
