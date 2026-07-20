import re

with open("backend/src/main/java/com/manga/library/service/ChapterExportService.java", "r") as f:
    content = f.read()

# 1. Change method signature
content = content.replace(
    "public void buildAndUploadExport(UUID chapterId, UUID userId, String exportId) {",
    "public void buildAndUploadExport(UUID chapterId, UUID userId, boolean force) {"
)

# 2. Change export name generation
old_hash = """      String hashExportId = hexString.toString();"""
new_hash = """      String hashExportId = chapterId.toString() + "_" + hexString.toString();"""
content = content.replace(old_hash, new_hash)

# 3. Add force bypass
old_cache = """      if (minioService.fileExists("exports/" + hashExportId + ".zip")) {"""
new_cache = """      if (!force && minioService.fileExists("exports/" + hashExportId + ".zip")) {"""
content = content.replace(old_cache, new_cache)

# 4. Append clearChapterExports
clear_method = """
  @Transactional
  public void clearChapterExports(UUID chapterId) {
    try {
      Iterable<io.minio.Result<io.minio.messages.Item>> results =
          minioService.getMinioClient().listObjects(
              io.minio.ListObjectsArgs.builder().bucket(minioService.getBucketName()).prefix("exports/" + chapterId.toString() + "_").build());
      for (io.minio.Result<io.minio.messages.Item> result : results) {
        io.minio.messages.Item item = result.get();
        minioService.getMinioClient().removeObject(
            io.minio.RemoveObjectArgs.builder().bucket(minioService.getBucketName()).object(item.objectName()).build());
      }
    } catch (Exception e) {
      log.error("Failed to clear chapter exports", e);
    }
  }
}"""
content = content[:content.rfind("}")] + clear_method + "\n"

with open("backend/src/main/java/com/manga/library/service/ChapterExportService.java", "w") as f:
    f.write(content)
