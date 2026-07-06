package com.manga.library.model;

import jakarta.persistence.*;
import java.util.UUID;
import lombok.*;

@Entity
@Table(name = "panels")
@Getter
@Setter
@ToString(exclude = {"image"})
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Panel {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
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
}
