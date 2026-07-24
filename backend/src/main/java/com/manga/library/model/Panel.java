package com.manga.library.model;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "panels")
public class Panel {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "image_id", nullable = false)
  @com.fasterxml.jackson.annotation.JsonIgnore
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
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

  public Panel() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public Image getImage() {
    return this.image;
  }

  public void setImage(Image image) {
    this.image = image;
  }

  public Integer getBboxX() {
    return this.bboxX;
  }

  public void setBboxX(Integer bboxX) {
    this.bboxX = bboxX;
  }

  public Integer getBboxY() {
    return this.bboxY;
  }

  public void setBboxY(Integer bboxY) {
    this.bboxY = bboxY;
  }

  public Integer getBboxW() {
    return this.bboxW;
  }

  public void setBboxW(Integer bboxW) {
    this.bboxW = bboxW;
  }

  public Integer getBboxH() {
    return this.bboxH;
  }

  public void setBboxH(Integer bboxH) {
    this.bboxH = bboxH;
  }

  public Integer getGridRow() {
    return this.gridRow;
  }

  public void setGridRow(Integer gridRow) {
    this.gridRow = gridRow;
  }

  public Integer getGridCol() {
    return this.gridCol;
  }

  public void setGridCol(Integer gridCol) {
    this.gridCol = gridCol;
  }

  public Integer getReadingOrder() {
    return this.readingOrder;
  }

  public void setReadingOrder(Integer readingOrder) {
    this.readingOrder = readingOrder;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Panel)) return false;
    Panel that = (Panel) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
