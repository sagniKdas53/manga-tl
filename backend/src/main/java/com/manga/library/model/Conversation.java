package com.manga.library.model;

import jakarta.persistence.*;
import java.util.UUID;
import lombok.*;

@Entity
@Table(name = "conversations")
@Getter
@Setter
@ToString(exclude = {"page"})
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Conversation {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "page_id", nullable = false)
  @com.fasterxml.jackson.annotation.JsonIgnore
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Page page;

  @Column(name = "scene_type", nullable = false)
  @Builder.Default
  private String sceneType =
      "dialogue"; // dialogue | monologue | narration | flashback | sfx_cluster
}
