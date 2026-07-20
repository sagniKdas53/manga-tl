package com.manga.library.model;

import jakarta.persistence.*;
import java.time.Instant;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.UpdateTimestamp;

@Data
@NoArgsConstructor
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
}
