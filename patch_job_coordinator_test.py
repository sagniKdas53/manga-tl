import re

with open("backend/src/test/java/com/manga/library/service/JobCoordinatorServiceTest.java", "r") as f:
    content = f.read()

# Add mock field
mock_field = """  @Mock private SystemSettingRepository systemSettingRepository;
  @Mock private com.manga.library.repository.JobCostRepository jobCostRepository;"""
content = content.replace("  @Mock private SystemSettingRepository systemSettingRepository;", mock_field)

with open("backend/src/test/java/com/manga/library/service/JobCoordinatorServiceTest.java", "w") as f:
    f.write(content)
