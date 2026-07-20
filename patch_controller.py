import re

with open("backend/src/main/java/com/manga/library/controller/SeriesController.java", "r") as f:
    content = f.read()

# Update export endpoint
old_export = """  @GetMapping("/chapters/{chapterId}/export")
  public ResponseEntity<?> exportChapter(
      @PathVariable UUID chapterId, @RequestHeader(value = "X-User-Id", required = false) String userIdStr) {"""

new_export = """  @GetMapping("/chapters/{chapterId}/export")
  public ResponseEntity<?> exportChapter(
      @PathVariable UUID chapterId, 
      @RequestParam(defaultValue = "false") boolean force,
      @RequestHeader(value = "X-User-Id", required = false) String userIdStr) {"""
content = content.replace(old_export, new_export)

# Replace the call
content = content.replace(
    "chapterExportService.buildAndUploadExport(chapterId, userId, exportId);",
    "chapterExportService.buildAndUploadExport(chapterId, userId, force);"
)

# Add clear endpoint
clear_endpoint = """
  @DeleteMapping("/chapters/{chapterId}/exports")
  public ResponseEntity<?> clearExports(@PathVariable UUID chapterId) {
    chapterExportService.clearChapterExports(chapterId);
    return ResponseEntity.ok(Map.of("message", "Cleared exports for chapter"));
  }
"""
idx = content.find("  @GetMapping(\"/chapters/exports/{exportId}/download\")")
content = content[:idx] + clear_endpoint + content[idx:]

with open("backend/src/main/java/com/manga/library/controller/SeriesController.java", "w") as f:
    f.write(content)
