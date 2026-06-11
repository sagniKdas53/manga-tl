package com.manga.library.model;

import jakarta.persistence.*;
import lombok.*;
import java.io.Serializable;
import java.util.UUID;

@Entity
@Table(name = "conversation_regions")
@Data
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

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ConversationRegionId implements Serializable {
        private UUID conversationId;
        private UUID regionId;
    }
}
