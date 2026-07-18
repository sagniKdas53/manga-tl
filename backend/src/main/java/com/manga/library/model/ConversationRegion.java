package com.manga.library.model;

import jakarta.persistence.*;
import java.io.Serializable;
import java.util.UUID;
import lombok.*;

@Entity
@Table(name = "conversation_regions")
@Getter
@Setter
@ToString
@EqualsAndHashCode
@NoArgsConstructor
@AllArgsConstructor
@Builder
@IdClass(ConversationRegion.ConversationRegionId.class)
public class ConversationRegion {

  @Id
  @Column(name = "conversation_id")
  private UUID conversationId;

  @Id
  @Column(name = "region_id")
  private UUID regionId;

  @Column(nullable = false)
  private Integer position;

  @Getter
  @Setter
  @ToString
  @EqualsAndHashCode
  @NoArgsConstructor
  @AllArgsConstructor
  public static class ConversationRegionId implements Serializable {
    private UUID conversationId;
    private UUID regionId;
  }
}
