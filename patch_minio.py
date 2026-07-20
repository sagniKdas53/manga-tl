import re

with open("backend/src/main/java/com/manga/library/service/MinioService.java", "r") as f:
    content = f.read()

# Add getters
getters = """
  public MinioClient getMinioClient() {
    return minioClient;
  }

  public String getBucketName() {
    return bucketName;
  }
}"""
content = content.replace("}\n", getters, 1)

with open("backend/src/main/java/com/manga/library/service/MinioService.java", "w") as f:
    f.write(content)
