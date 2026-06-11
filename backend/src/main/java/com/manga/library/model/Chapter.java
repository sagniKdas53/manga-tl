package com.manga.library.model;

import jakarta.persistence.*;
import lombok.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "chapters", uniqueConstraints = {@UniqueConstraint(columnNames = {"series_id", "chapter_number"})})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Chapter {
    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "volume_id")
    private Volume volume;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "series_id", nullable = false)
    private Series series;

    @Column(name = "chapter_number", nullable = false)
    private Integer chapterNumber;

    private String title;

    @Column(name = "summary_json")
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String summaryJson;

    @Column(name = "summary_generated_at")
    private OffsetDateTime summaryGeneratedAt;
}
