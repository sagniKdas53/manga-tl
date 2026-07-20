import re

with open("backend/src/main/java/com/manga/library/dto/SystemSettingsDto.java", "r") as f:
    content = f.read()

content = content.replace("private List<String> qaVlmModelList;", "private List<String> qaVlmModelList;\n  private String routingStrategy;")

with open("backend/src/main/java/com/manga/library/dto/SystemSettingsDto.java", "w") as f:
    f.write(content)
