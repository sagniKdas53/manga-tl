import re

filepath = "/home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/service/JobCoordinatorService.java"
with open(filepath, "r") as f:
    content = f.read()

# Replace getters for OcrRegionData
getters_ocr = [
    "Confidence", "Rotation", "X", "Y", "Width", "Height", 
    "BubbleReadingOrder", "BackgroundColor", "BubbleX", "BubbleY", 
    "BubbleWidth", "BubbleHeight", "BubbleId", "DetectionConfidence", 
    "MaskPolygon", "SafeTextX", "SafeTextY", "SafeTextW", "SafeTextH",
    "Text", "DetectedLanguage", "PanelReadingOrder", "ConversationGroup"
]

for g in getters_ocr:
    # replace rData.getSomething() with rData.something()
    content = re.sub(rf'rData\.get{g}\(\)', f'rData.{g[0].lower() + g[1:]}()', content)
    # also for dto
    content = re.sub(rf'dto\.get{g}\(\)', f'dto.{g[0].lower() + g[1:]}()', content)

# OcrCallbackDto fields
getters_ocr_dto = [
    "ImageId", "PageId", "ModelIdentifier", "Confidence", "Cost", "Regions"
]
for g in getters_ocr_dto:
    content = re.sub(rf'dto\.get{g}\(\)', f'dto.{g[0].lower() + g[1:]}()', content)

# Replace getters for ChapterDto
# ChapterDto fields
getters_chapter = [
    "Id", "SeriesId", "ChapterNumber", "Title", "CoverImageUrl",
    "OcrProvider", "OcrModel", "TlProvider", "TlModel",
    "QaProvider", "QaLlmModel", "QaVlmModel", "QaMode",
    "RoutingStrategy", "UseContextMemory", "UseFallbackModels",
    "PageCount", "CreatedAt", "UpdatedAt",
    "ResolvedOcr", "ResolvedTranslation", "ResolvedQa"
]
for g in getters_chapter:
    content = re.sub(rf'\.get{g}\(\)', f'.{g[0].lower() + g[1:]}()', content)

# PanelCallbackDto fields
getters_panel = ["ImageId", "PageId", "Panels"]
for g in getters_panel:
    content = re.sub(rf'\.get{g}\(\)', f'.{g[0].lower() + g[1:]}()', content)
    
getters_panel_data = ["X", "Y", "Width", "Height", "GridRow", "GridCol", "ReadingOrder"]
for g in getters_panel_data:
    content = re.sub(rf'pData\.get{g}\(\)', f'pData.{g[0].lower() + g[1:]}()', content)

with open(filepath, "w") as f:
    f.write(content)
