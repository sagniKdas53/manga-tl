package com.manga.library.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "system_settings")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SystemSetting {

  @Id
  @Column(name = "setting_key", nullable = false)
  private String settingKey;

  @Column(name = "setting_value", nullable = false)
  private String settingValue;

  @Column(name = "updated_at", nullable = false)
  private OffsetDateTime updatedAt;

  @PrePersist
  @PreUpdate
  protected void onUpdate() {
    updatedAt = OffsetDateTime.now();
  }
}
