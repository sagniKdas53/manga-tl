import re

file_path = "src/main/java/com/manga/library/controller/SeriesController.java"
with open(file_path, "r") as f:
    content = f.read()

# Replace dto.getSomething() with dto.something()
content = re.sub(r'\bdto\.get([A-Z])([a-zA-Z0-9_]*)\(\)', lambda m: "dto." + m.group(1).lower() + m.group(2) + "()", content)

# Replace globalSettings.getSomething() with globalSettings.something()
content = re.sub(r'\bglobalSettings\.get([A-Z])([a-zA-Z0-9_]*)\(\)', lambda m: "globalSettings." + m.group(1).lower() + m.group(2) + "()", content)

with open(file_path, "w") as f:
    f.write(content)

