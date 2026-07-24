import re
import os

files = [
    "src/main/java/com/manga/library/controller/InternalJobController.java",
    "src/main/java/com/manga/library/controller/AuthController.java",
]

for file_path in files:
    with open(file_path, "r") as f:
        content = f.read()

    # Replace .getSomething() with .something() for dto/request/pData/rData
    content = re.sub(r'\b(dto|request|pData|rData)\.get([A-Z])([a-zA-Z0-9_]*)\(\)', lambda m: m.group(1) + "." + m.group(2).lower() + m.group(3) + "()", content)

    with open(file_path, "w") as f:
        f.write(content)

