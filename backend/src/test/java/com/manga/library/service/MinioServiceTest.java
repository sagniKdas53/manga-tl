package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import io.minio.*;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.multipart.MultipartFile;

@ExtendWith(MockitoExtension.class)
public class MinioServiceTest {

  @Mock private MinioClient minioClient;

  @InjectMocks private MinioService minioService;

  @BeforeEach
  public void setUp() {
    ReflectionTestUtils.setField(minioService, "bucketName", "test-bucket");
    ReflectionTestUtils.setField(minioService, "endpoint", "http://localhost:9000");
    ReflectionTestUtils.setField(minioService, "externalUrl", "http://external:9000");
  }

  @Test
  public void testInit_BucketExists() throws Exception {
    when(minioClient.bucketExists(any(BucketExistsArgs.class))).thenReturn(true);
    minioService.init();
    verify(minioClient, times(1)).bucketExists(any(BucketExistsArgs.class));
    verify(minioClient, never()).makeBucket(any(MakeBucketArgs.class));
  }

  @Test
  public void testInit_BucketDoesNotExist() throws Exception {
    when(minioClient.bucketExists(any(BucketExistsArgs.class))).thenReturn(false);
    minioService.init();
    verify(minioClient, times(1)).bucketExists(any(BucketExistsArgs.class));
    verify(minioClient, times(1)).makeBucket(any(MakeBucketArgs.class));
  }

  @Test
  public void testUploadFileMultipart() throws Exception {
    MultipartFile file = mock(MultipartFile.class);
    when(file.getInputStream()).thenReturn(new ByteArrayInputStream("test".getBytes()));
    when(file.getSize()).thenReturn(4L);
    when(file.getContentType()).thenReturn("image/png");

    String result = minioService.uploadFile("path/to/file.png", file);
    assertEquals("path/to/file.png", result);
    verify(minioClient, times(1)).putObject(any(PutObjectArgs.class));
  }

  @Test
  public void testUploadFileBytes() throws Exception {
    byte[] bytes = "test".getBytes();
    String result = minioService.uploadFile("path/to/file.png", bytes, "image/png");
    assertEquals("path/to/file.png", result);
    verify(minioClient, times(1)).putObject(any(PutObjectArgs.class));
  }

  @Test
  public void testDownloadFile() throws Exception {
    GetObjectResponse mockResponse = mock(GetObjectResponse.class);
    when(minioClient.getObject(any(GetObjectArgs.class))).thenReturn(mockResponse);

    InputStream result = minioService.downloadFile("path/to/file.png");
    assertSame(mockResponse, result);
  }

  @Test
  public void testGeneratePresignedUrl() throws Exception {
    when(minioClient.getPresignedObjectUrl(any(GetPresignedObjectUrlArgs.class)))
        .thenReturn("http://localhost:9000/test-bucket/path/to/file.png");

    String url = minioService.generatePresignedUrl("path/to/file.png");
    assertEquals("http://external:9000/test-bucket/path/to/file.png", url);
  }

  @Test
  public void testDeleteFile() throws Exception {
    minioService.deleteFile("path/to/file.png");
    verify(minioClient, times(1)).removeObject(any(RemoveObjectArgs.class));
  }

  @Test
  public void testInit_Exception() throws Exception {
    when(minioClient.bucketExists(any(BucketExistsArgs.class)))
        .thenThrow(new RuntimeException("MinIO down"));
    assertDoesNotThrow(() -> minioService.init());
  }

  @Test
  public void testGeneratePresignedUrl_Exception() throws Exception {
    when(minioClient.getPresignedObjectUrl(any(GetPresignedObjectUrlArgs.class)))
        .thenThrow(new RuntimeException("Failed generating URL"));

    String url = minioService.generatePresignedUrl("path/to/file.png");
    assertNull(url);
  }

  @Test
  public void testDeleteFile_Exception() throws Exception {
    doThrow(new RuntimeException("Delete failed"))
        .when(minioClient)
        .removeObject(any(RemoveObjectArgs.class));
    assertDoesNotThrow(() -> minioService.deleteFile("path/to/file.png"));
  }

  @Test
  public void testGetFileStream() throws Exception {
    GetObjectResponse mockResponse = mock(GetObjectResponse.class);
    when(minioClient.getObject(any(GetObjectArgs.class))).thenReturn(mockResponse);

    InputStream result = minioService.getFileStream("path/to/file.png");
    assertSame(mockResponse, result);
  }
}
