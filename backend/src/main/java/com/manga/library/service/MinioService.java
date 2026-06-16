package com.manga.library.service;

import io.minio.*;
import jakarta.annotation.PostConstruct;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

@Service
@RequiredArgsConstructor
@Slf4j
public class MinioService {

  private final MinioClient minioClient;

  @Value("${minio.bucketName}")
  private String bucketName;

  @PostConstruct
  public void init() {
    try {
      boolean found =
          minioClient.bucketExists(BucketExistsArgs.builder().bucket(bucketName).build());
      if (!found) {
        minioClient.makeBucket(MakeBucketArgs.builder().bucket(bucketName).build());
        log.info("Successfully created MinIO bucket: {}", bucketName);
      }
    } catch (Exception e) {
      log.error("Failed to initialize MinIO bucket", e);
    }
  }

  public String uploadFile(String objectPath, MultipartFile file) throws Exception {
    try (InputStream is = file.getInputStream()) {
      minioClient.putObject(
          PutObjectArgs.builder().bucket(bucketName).object(objectPath).stream(
                  is, file.getSize(), -1L)
              .contentType(file.getContentType())
              .build());
      return objectPath;
    }
  }

  public InputStream downloadFile(String objectPath) throws Exception {
    return minioClient.getObject(
        GetObjectArgs.builder().bucket(bucketName).object(objectPath).build());
  }

  public String generatePresignedUrl(String objectPath) {
    try {
      return minioClient.getPresignedObjectUrl(
          GetPresignedObjectUrlArgs.builder()
              .method(Http.Method.GET)
              .bucket(bucketName)
              .object(objectPath)
              .expiry(2, TimeUnit.HOURS)
              .build());
    } catch (Exception e) {
      log.error("Error generating presigned URL for {}", objectPath, e);
      return null;
    }
  }

  public InputStream getFileStream(String objectPath) throws Exception {
    return minioClient.getObject(
        GetObjectArgs.builder().bucket(bucketName).object(objectPath).build());
  }

  public void deleteFile(String objectPath) {
    try {
      minioClient.removeObject(
          RemoveObjectArgs.builder().bucket(bucketName).object(objectPath).build());
      log.info("Successfully deleted MinIO file: {}", objectPath);
    } catch (Exception e) {
      log.error("Failed to delete MinIO file: {}", objectPath, e);
    }
  }
}
