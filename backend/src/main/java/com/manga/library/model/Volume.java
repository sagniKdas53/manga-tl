package com.manga.library.model;

import jakarta.persistence.*;
import lombok.*;
import java.util.UUID;

@Entity
@Table(name = "volumes", uniqueConstraints = {@UniqueConstraint(columnNames = {"series_id", "volume_number"})})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Volume {
    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "series_id", nullable = false)
    private Series series;

    @Column(name = "volume_number", nullable = false)
    private Integer volumeNumber;

    private String title;
}
