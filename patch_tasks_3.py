import re

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "r") as f:
    content = f.read()

content = content.replace("- [ ] **E.5 Chapter Export Cleanup**", "- [x] **E.5 Chapter Export Cleanup**")
content = content.replace("- [ ] Create `ExportCleanupService.java`", "- [x] Create `ExportCleanupService.java`")

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "w") as f:
    f.write(content)
