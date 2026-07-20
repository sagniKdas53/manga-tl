import re

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "r") as f:
    content = f.read()

content = content.replace("- [ ] **E.2 Strict HTTP Timeouts**", "- [x] **E.2 Strict HTTP Timeouts**")
content = content.replace("- [ ] Update `services/translation.py` & `services/ocr.py` outbound requests with `timeout=(10, 45)`", "- [x] Update `services/translation.py` & `services/ocr.py` outbound requests with `timeout=(10, 45)`")

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "w") as f:
    f.write(content)
