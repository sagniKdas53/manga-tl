import re

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "r") as f:
    content = f.read()

content = content.replace("- [ ] **E.3 Migrate Cost Tracking to DB**", "- [x] **E.3 Migrate Cost Tracking to DB**")
content = content.replace("- [ ] Create `job_costs` table", "- [x] Create `job_costs` table")
content = content.replace("- [ ] Update `JobCoordinatorService.java` to persist cost payloads", "- [x] Update `JobCoordinatorService.java` to persist cost payloads")
content = content.replace("- [ ] Remove `costs.json` fallback from `worker/utils/rate_limit.py`", "- [x] Remove `costs.json` fallback from `worker/utils/rate_limit.py`")

with open("/home/sagnik/.gemini/antigravity-ide/brain/956b5d57-5090-453b-a6f1-99a8825fd210/task.md", "w") as f:
    f.write(content)
