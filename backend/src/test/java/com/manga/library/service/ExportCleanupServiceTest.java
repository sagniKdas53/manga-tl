package com.manga.library.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import io.minio.ListObjectsArgs;
import io.minio.MinioClient;
import io.minio.Result;
import io.minio.messages.Item;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.Iterator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
@SuppressWarnings("null")
public class ExportCleanupServiceTest {

  @Mock private MinioClient minioClient;

  private ExportCleanupService service;

  @BeforeEach
  void setUp() {
    service = new ExportCleanupService(minioClient);
    ReflectionTestUtils.setField(service, "bucketName", "test-bucket");
    ReflectionTestUtils.setField(service, "retentionDays", 7);
  }

  @Test
  void cleanupOldExports_noFiles() throws Exception {
    when(minioClient.listObjects(any(ListObjectsArgs.class)))
        .thenReturn(Collections.emptyList());

    service.cleanupOldExports();

    verify(minioClient).listObjects(any(ListObjectsArgs.class));
    verify(minioClient, never()).removeObject(any());
  }

  @Test
  void cleanupOldExports_skipsDirectories() throws Exception {
    Item dirItem = mock(Item.class);
    when(dirItem.isDir()).thenReturn(true);

    Result<Item> result = mock(Result.class);
    when(result.get()).thenReturn(dirItem);

    when(minioClient.listObjects(any(ListObjectsArgs.class)))
        .thenAnswer(inv -> singleItemIterable(result));

    service.cleanupOldExports();

    verify(minioClient, never()).removeObject(any());
  }

  @Test
  void cleanupOldExports_deletesOldFile() throws Exception {
    ZonedDateTime oldDate = ZonedDateTime.now().minusDays(10);

    Item fileItem = mock(Item.class);
    when(fileItem.isDir()).thenReturn(false);
    when(fileItem.lastModified()).thenReturn(oldDate);
    when(fileItem.objectName()).thenReturn("exports/test.zip");

    Result<Item> result = mock(Result.class);
    when(result.get()).thenReturn(fileItem);

    when(minioClient.listObjects(any(ListObjectsArgs.class)))
        .thenAnswer(inv -> singleItemIterable(result));

    service.cleanupOldExports();

    verify(minioClient).removeObject(any());
  }

  @Test
  void cleanupOldExports_keepsNewFile() throws Exception {
    ZonedDateTime newDate = ZonedDateTime.now().minusDays(1);

    Item fileItem = mock(Item.class);
    when(fileItem.isDir()).thenReturn(false);
    when(fileItem.lastModified()).thenReturn(newDate);

    Result<Item> result = mock(Result.class);
    when(result.get()).thenReturn(fileItem);

    when(minioClient.listObjects(any(ListObjectsArgs.class)))
        .thenAnswer(inv -> singleItemIterable(result));

    service.cleanupOldExports();

    verify(minioClient, never()).removeObject(any());
  }

  @Test
  void cleanupOldExports_handlesNullLastModified() throws Exception {
    Item fileItem = mock(Item.class);
    when(fileItem.isDir()).thenReturn(false);
    when(fileItem.lastModified()).thenReturn(null);

    Result<Item> result = mock(Result.class);
    when(result.get()).thenReturn(fileItem);

    when(minioClient.listObjects(any(ListObjectsArgs.class)))
        .thenAnswer(inv -> singleItemIterable(result));

    service.cleanupOldExports();

    verify(minioClient, never()).removeObject(any());
  }

  @Test
  void cleanupOldExports_handlesListException() throws Exception {
    when(minioClient.listObjects(any(ListObjectsArgs.class)))
        .thenThrow(new RuntimeException("MinIO connection failed"));

    service.cleanupOldExports();

    verify(minioClient, never()).removeObject(any());
  }

  private Iterable<Result<Item>> singleItemIterable(Result<Item> result) {
    return () -> new Iterator<Result<Item>>() {
      private boolean hasNext = true;
      @Override public boolean hasNext() { return hasNext; }
      @Override public Result<Item> next() { hasNext = false; return result; }
    };
  }
}