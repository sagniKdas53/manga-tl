import re

with open("src/test/java/com/manga/library/service/JobCoordinatorServiceTest.java", "r") as f:
    content = f.read()

# Replace the DTO instantiations manually
# 1. OcrRegionData
region_target = """    com.manga.library.dto.OcrCallbackDto.OcrRegionData r =
        new com.manga.library.dto.OcrCallbackDto.OcrRegionData();
    r.setText("Hello");
    r.setX(10);
    r.setY(20);
    r.setWidth(100);
    r.setHeight(50);
    r.setDetectedLanguage("en");"""
region_repl = """    com.manga.library.dto.OcrCallbackDto.OcrRegionData r =
        new com.manga.library.dto.OcrCallbackDto.OcrRegionData("Hello", "en", null, null, 10, 20, 100, 50, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null);"""
content = content.replace(region_target, region_repl)

# 2. OcrCallbackDto
callback_target = """    com.manga.library.dto.OcrCallbackDto dto = new com.manga.library.dto.OcrCallbackDto();
    dto.setRegions(List.of(r));
    dto.setModelIdentifier("test-model");
    dto.setConfidence(0.99);"""
callback_repl = """    com.manga.library.dto.OcrCallbackDto dto = new com.manga.library.dto.OcrCallbackDto(null, null, "test-model", 0.99, null, List.of(r));"""
content = content.replace(callback_target, callback_repl)

# 3. OcrCallbackDto (second instance)
callback2_target = """    com.manga.library.dto.OcrCallbackDto dto = new com.manga.library.dto.OcrCallbackDto();
    dto.setImageId(targetId);
    dto.setRegions(List.of(new Object())); // Invalid region to cause error
    dto.setModelIdentifier("test");
    dto.setConfidence(0.99);"""
callback2_repl = """    com.manga.library.dto.OcrCallbackDto dto = new com.manga.library.dto.OcrCallbackDto(targetId, null, "test", 0.99, null, List.of()); // Invalid region logic changed because we can't use Object"""
content = content.replace(callback2_target, callback2_repl)

with open("src/test/java/com/manga/library/service/JobCoordinatorServiceTest.java", "w") as f:
    f.write(content)
