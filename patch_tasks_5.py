import re

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "r") as f:
    content = f.read()

content = content.replace("- [ ] **E.6 & E.7 OpenRouter Routing**", "- [x] **E.6 & E.7 OpenRouter Routing**")
content = content.replace("- [ ] Add `routingStrategy` to `SystemSettingsDto`", "- [x] Add `routingStrategy` to `SystemSettingsDto`")
content = content.replace("- [ ] Add Dropdown in Settings UI", "- [x] Add Dropdown in Settings UI")
content = content.replace("- [ ] Inject in `JobCoordinatorService`", "- [x] Inject in `JobCoordinatorService`")
content = content.replace("- [ ] Pass strategy to worker API services", "- [x] Pass strategy to worker API services")
content = content.replace("- [ ] Append payload when calling OpenRouter if lowest-cost", "- [x] Append payload when calling OpenRouter if lowest-cost")

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "w") as f:
    f.write(content)
