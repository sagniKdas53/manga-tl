import re

with open("backend/src/main/java/com/manga/library/service/SystemSettingsService.java", "r") as f:
    content = f.read()

content = content.replace(
    "saveSetting(\"qaVlmModel\", dto.getQaVlmModel());",
    "saveSetting(\"qaVlmModel\", dto.getQaVlmModel());\n    saveSetting(\"routingStrategy\", dto.getRoutingStrategy());"
)

content = content.replace(
    "dto.setQaVlmModelList(parseList(getSettingValue(\"qaVlmModelList\", \"\")));",
    "dto.setQaVlmModelList(parseList(getSettingValue(\"qaVlmModelList\", \"\")));\n    dto.setRoutingStrategy(getSettingValue(\"routingStrategy\", \"lowest-cost\"));"
)

with open("backend/src/main/java/com/manga/library/service/SystemSettingsService.java", "w") as f:
    f.write(content)
