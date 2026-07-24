package com.manga.library.model;

import jakarta.persistence.*;
import java.time.Instant;
import org.hibernate.annotations.UpdateTimestamp;

@Entity
@Table(name = "model_rates")
public class ModelRate {
  @Id
  @Column(name = "model_id")
  private String modelId;

  @Column(name = "provider")
  private String provider;

  @Column(name = "prompt_price")
  private Double promptPrice;

  @Column(name = "completion_price")
  private Double completionPrice;

  @UpdateTimestamp
  @Column(name = "updated_at")
  private Instant updatedAt;

  public ModelRate() {}

  public String getModelId() {
    return this.modelId;
  }

  public void setModelId(String modelId) {
    this.modelId = modelId;
  }

  public String getProvider() {
    return this.provider;
  }

  public void setProvider(String provider) {
    this.provider = provider;
  }

  public Double getPromptPrice() {
    return this.promptPrice;
  }

  public void setPromptPrice(Double promptPrice) {
    this.promptPrice = promptPrice;
  }

  public Double getCompletionPrice() {
    return this.completionPrice;
  }

  public void setCompletionPrice(Double completionPrice) {
    this.completionPrice = completionPrice;
  }

  public Instant getUpdatedAt() {
    return this.updatedAt;
  }

  public void setUpdatedAt(Instant updatedAt) {
    this.updatedAt = updatedAt;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof ModelRate)) return false;
    ModelRate that = (ModelRate) o;
    return modelId != null && modelId.equals(that.getModelId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
