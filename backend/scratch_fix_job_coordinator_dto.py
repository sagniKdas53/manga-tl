import re

file_path = "src/main/java/com/manga/library/service/JobCoordinatorService.java"
with open(file_path, "r") as f:
    content = f.read()

# Fix PanelCallbackDto and PanelData accessors
# dto.getPanels() -> dto.panels()
# pData.getX() -> pData.x()
content = re.sub(r'\bdto\.get([A-Z])([a-zA-Z0-9_]*)\(\)', lambda m: "dto." + m.group(1).lower() + m.group(2) + "()", content)
content = re.sub(r'\bpData\.get([A-Z])([a-zA-Z0-9_]*)\(\)', lambda m: "pData." + m.group(1).lower() + m.group(2) + "()", content)
content = re.sub(r'\brData\.get([A-Z])([a-zA-Z0-9_]*)\(\)', lambda m: "rData." + m.group(1).lower() + m.group(2) + "()", content)

with open(file_path, "w") as f:
    f.write(content)

