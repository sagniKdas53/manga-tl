package com.manga.library.service;

import io.minio.ListObjectsArgs;
import io.minio.MinioClient;
import io.minio.RemoveObjectArgs;
import io.minio.Result;
import io.minio.messages.Item;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class ExportCleanupService {
  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(ExportCleanupService.class);
  
  @org.springframework.beans.factory.annotation.Value("${minio.bucket-name}")
  private String bucketName;

  @org.springframework.beans.factory.annotation.Value("${app.export.retention.days:7}")
  private int retentionDays;


  private final MinioClient minioClient;
  public ExportCleanupService(MinioClient minioClient) {
    this.minioClient = minioClient;
  }



  /** Run every day at 2:00 AM server time. */
  @Scheduled(cron = "0 0 2 * * ?")
  public void cleanupOldExports() {
    log.info("Starting scheduled cleanup of old chapter exports in MinIO...");
    try {
      Iterable<Result<Item>> results =
          minioClient.listObjects(
              ListObjectsArgs.builder().bucket(bucketName).prefix("exports/").build());

      Instant threshold = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
      int deletedCount = 0;

      for (Result<Item> result : results) {
        Item item = result.get();
        if (item.isDir()) {
          continue;
        }

        ZonedDateTime lastModified = item.lastModified();
        if (lastModified != null && lastModified.toInstant().isBefore(threshold)) {
          log.debug("Deleting old export: {}", item.objectName());
          minioClient.removeObject(
              RemoveObjectArgs.builder().bucket(bucketName).object(item.objectName()).build());
          deletedCount++;
        }
      }

      log.info("Finished export cleanup. Deleted {} old files.", deletedCount);
    } catch (Exception e) {
      log.error("Failed to clean up old exports in MinIO", e);
    }
  }
}
