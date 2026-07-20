import re

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "r") as f:
    content = f.read()

content = content.replace("- [ ] **E.4 Configurable Audit Cache**", "- [x] **E.4 Configurable Audit Cache**")
content = content.replace("- [ ] Add `ENABLE_QA_AUDIT_CACHE` condition", "- [x] Add `ENABLE_QA_AUDIT_CACHE` condition")
content = content.replace("- [ ] Add cleanup routine on startup", "- [x] Add cleanup routine on startup")

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "w") as f:
    f.write(content)
