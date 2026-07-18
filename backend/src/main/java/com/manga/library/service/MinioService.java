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
@SuppressWarnings("null")
public class MinioService {

  private final MinioClient minioClient;

  @Value("${minio.bucketName}")
  private String bucketName;

  @Value("${minio.externalUrl:}")
  private String externalUrl;

  @Value("${minio.endpoint}")
  private String endpoint;

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

  public String uploadFile(String objectPath, MultipartFile file)
      throws io.minio.errors.MinioException, java.io.IOException {
    try (InputStream is = file.getInputStream()) {
      minioClient.putObject(
          PutObjectArgs.builder().bucket(bucketName).object(objectPath).stream(
                  is, file.getSize(), -1L)
              .contentType(file.getContentType())
              .build());
      return objectPath;
    }
  }

  public String uploadFile(String objectPath, byte[] bytes, String contentType)
      throws io.minio.errors.MinioException, java.io.IOException {
    try (java.io.ByteArrayInputStream bais = new java.io.ByteArrayInputStream(bytes)) {
      minioClient.putObject(
          PutObjectArgs.builder().bucket(bucketName).object(objectPath).stream(
                  bais, (long) bytes.length, -1L)
              .contentType(contentType)
              .build());
      return objectPath;
    }
  }

  public InputStream downloadFile(String objectPath) throws io.minio.errors.MinioException {
    return minioClient.getObject(
        GetObjectArgs.builder().bucket(bucketName).object(objectPath).build());
  }

  public String generatePresignedUrl(String objectPath) {
    try {
      String url =
          minioClient.getPresignedObjectUrl(
              GetPresignedObjectUrlArgs.builder()
                  .method(Http.Method.GET)
                  .bucket(bucketName)
                  .object(objectPath)
                  .expiry(10, TimeUnit.MINUTES)
                  .build());
      if (externalUrl != null && !externalUrl.trim().isEmpty() && url != null) {
        url = url.replace(endpoint, externalUrl);
      }
      return url;
    } catch (Exception e) {
      log.error("Error generating presigned URL for {}", objectPath, e);
      return null;
    }
  }

  public InputStream getFileStream(String objectPath) throws io.minio.errors.MinioException {
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

  public boolean fileExists(String objectPath) {
    try {
      minioClient.statObject(
          StatObjectArgs.builder().bucket(bucketName).object(objectPath).build());
      return true;
    } catch (Exception e) {
      return false;
    }
  }
}
