import re

file_path = "src/main/java/com/manga/library/controller/SeriesController.java"
with open(file_path, "r") as f:
    content = f.read()

content = re.sub(r'z\.getName\(\)', 'z.name()', content)
content = re.sub(r'imgEntry\.getName\(\)', 'imgEntry.name()', content)
content = re.sub(r'imgEntry\.getBytes\(\)', 'imgEntry.bytes()', content)

with open(file_path, "w") as f:
    f.write(content)

