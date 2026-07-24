package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "layer_edit_history")
public class LayerEditHistory {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
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

  public LayerEditHistory() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public LayerElement getLayerElement() {
    return this.layerElement;
  }

  public void setLayerElement(LayerElement layerElement) {
    this.layerElement = layerElement;
  }

  public String getPreviousValueJson() {
    return this.previousValueJson;
  }

  public void setPreviousValueJson(String previousValueJson) {
    this.previousValueJson = previousValueJson;
  }

  public String getNewValueJson() {
    return this.newValueJson;
  }

  public void setNewValueJson(String newValueJson) {
    this.newValueJson = newValueJson;
  }

  public User getEditedBy() {
    return this.editedBy;
  }

  public void setEditedBy(User editedBy) {
    this.editedBy = editedBy;
  }

  public OffsetDateTime getEditedAt() {
    return this.editedAt;
  }

  public void setEditedAt(OffsetDateTime editedAt) {
    this.editedAt = editedAt;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof LayerEditHistory)) return false;
    LayerEditHistory that = (LayerEditHistory) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
