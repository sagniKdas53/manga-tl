import re

file_path = "src/main/java/com/manga/library/controller/SeriesController.java"
with open(file_path, "r") as f:
    content = f.read()

pattern = r'ChapterDto responseDto = new ChapterDto\(\);\s*populateChapterDto\(responseDto,\s*(.*?),\s*(.*?)\);'
content = re.sub(pattern, r'ChapterDto responseDto = toChapterDto(\1, \2);', content)

with open(file_path, "w") as f:
    f.write(content)

