import re

file_path = "src/test/java/com/manga/library/controller/InternalJobControllerTest.java"
with open(file_path, "r") as f:
    content = f.read()

# Replace:
# PanelCallbackDto dto = new PanelCallbackDto();
# dto.setImageId(imageId);
# With:
# PanelCallbackDto dto = new PanelCallbackDto(imageId, null, null);
content = re.sub(
    r'PanelCallbackDto dto = new PanelCallbackDto\(\);\s*dto\.setImageId\(([^)]+)\);',
    r'PanelCallbackDto dto = new PanelCallbackDto(\1, null, null);',
    content
)

# And similarly for OcrCallbackDto
# OcrCallbackDto dto = new OcrCallbackDto();
# dto.setImageId(imageId);
# Wait, OcrCallbackDto signature: OcrCallbackDto(UUID imageId, List<OcrRegionData> regions, Double cost)
content = re.sub(
    r'OcrCallbackDto dto = new OcrCallbackDto\(\);\s*dto\.setImageId\(([^)]+)\);',
    r'OcrCallbackDto dto = new OcrCallbackDto(\1, null, null);',
    content
)

with open(file_path, "w") as f:
    f.write(content)

