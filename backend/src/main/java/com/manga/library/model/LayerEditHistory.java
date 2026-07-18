package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.*;

@Entity
@Table(name = "layer_edit_history")
@Getter
@Setter
@ToString(exclude = {"layerElement", "editedBy"})
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
@SuppressWarnings("null")
public class LayerEditHistory {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "layer_element_id", nullable = false)
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private LayerElement layerElement;

  @Column(name = "previous_value_json")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private String previousValueJson;

  @Column(name = "new_value_json")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private String newValueJson;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "edited_by")
  private User editedBy;

  @Column(name = "edited_at", nullable = false, updatable = false)
  private OffsetDateTime editedAt;

  @PrePersist
  protected void onCreate() {
    editedAt = OffsetDateTime.now();
  }
}
