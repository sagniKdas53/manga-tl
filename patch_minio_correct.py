import re

with open("backend/src/main/java/com/manga/library/service/MinioService.java", "r") as f:
    content = f.read()

getters = """
  public MinioClient getMinioClient() {
    return minioClient;
  }

  public String getBucketName() {
    return bucketName;
  }
"""

content = content[:content.rfind("}")] + getters + "}\n"

with open("backend/src/main/java/com/manga/library/service/MinioService.java", "w") as f:
    f.write(content)
