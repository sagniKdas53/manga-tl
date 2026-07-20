import re

with open("backend/src/main/java/com/manga/library/service/JobCoordinatorService.java", "r") as f:
    content = f.read()

content = content.replace(
    "job.put(\n                  \"qaVlmModel\",",
    "job.put(\"routingStrategy\", settings.getRoutingStrategy());\n              job.put(\n                  \"qaVlmModel\","
)

with open("backend/src/main/java/com/manga/library/service/JobCoordinatorService.java", "w") as f:
    f.write(content)
