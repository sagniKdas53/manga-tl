import re

file_path = "src/main/java/com/manga/library/controller/SeriesController.java"
with open(file_path, "r") as f:
    content = f.read()

# Fix SeriesDto
to_dto = """  private SeriesDto toDto(Series s) {
    return new SeriesDto(
      s.getId(),
      s.getTitle(),
      s.getOriginalLanguage(),
      s.getSourceLanguage(),
      s.getTargetLanguage(),
      s.getReadingDirection(),
      s.getCoverImageId() != null ? getImageUrl(s.getCoverImageId()) : null,
      s.getOcrProvider(),
      s.getOcrModel(),
      s.getTlProvider(),
      s.getTlModel(),
      s.getQaProvider(),
      s.getQaLlmModel(),
      s.getQaVlmModel(),
      s.getQaMode(),
      s.getRoutingStrategy(),
      s.getUseFallbackModels(),
      s.getCreatedAt(),
      s.getUpdatedAt()
    );
  }"""
content = re.sub(r'  private SeriesDto toDto\(Series s\)\s*\{.*?(?=  private void populateChapterDto)', to_dto + "\n\n", content, flags=re.DOTALL)

# Fix ChapterDto
populate_method = r'  private void populateChapterDto\(ChapterDto dto, Chapter c, SystemSettingsDto globalSettings\)\s*\{.*?(?=\n  \}|\n  private)'
new_populate_method = """  private ChapterDto toChapterDto(Chapter c, SystemSettingsDto globalSettings) {
    Series series = c.getSeries();
    String gOcrProvider = globalSettings != null ? globalSettings.getOcrProvider() : null;
    String gOcrModel = globalSettings != null ? globalSettings.getOcrModel() : null;
    String gTlProvider = globalSettings != null ? globalSettings.getTlProvider() : null;
    String gTlModel = globalSettings != null ? globalSettings.getTlModel() : null;
    String gQaProvider = globalSettings != null ? globalSettings.getQaProvider() : null;
    String gQaLlmModel = globalSettings != null ? globalSettings.getQaLlmModel() : null;
    String gQaVlmModel = globalSettings != null ? globalSettings.getQaVlmModel() : null;
    String gQaMode = globalSettings != null ? globalSettings.getQaMode() : null;

    String ocrProv = c.getOcrProvider();
    String ocrMod = c.getOcrModel();
    String ocrSrc = "global";
    if (ocrProv == null && series != null) {
      ocrProv = series.getOcrProvider();
      ocrMod = series.getOcrModel();
      ocrSrc = "series";
    }
    if (ocrProv == null) {
      ocrProv = gOcrProvider;
      ocrMod = gOcrModel;
      ocrSrc = "global";
    } else if (c.getOcrProvider() != null) {
      ocrSrc = "chapter";
    }

    if ("local".equals(ocrProv)) {
      ocrMod = globalSettings != null && globalSettings.getLocalOcrModel() != null ? globalSettings.getLocalOcrModel() : "local";
    }
    var resolvedOcr = new ChapterDto.ResolvedModelSlot(ocrProv, ocrMod, ocrSrc);

    String tlProv = c.getTlProvider();
    String tlMod = c.getTlModel();
    String tlSrc = "global";
    if (tlProv == null && series != null) {
      tlProv = series.getTlProvider();
      tlMod = series.getTlModel();
      tlSrc = "series";
    }
    if (tlProv == null) {
      tlProv = gTlProvider;
      tlMod = gTlModel;
      tlSrc = "global";
    } else if (c.getTlProvider() != null) {
      tlSrc = "chapter";
    }
    var resolvedTranslation = new ChapterDto.ResolvedModelSlot(tlProv, tlMod, tlSrc);

    String qaProv = c.getQaProvider();
    String qaLlm = c.getQaLlmModel();
    String qaVlm = c.getQaVlmModel();
    String qaMod = c.getQaMode();
    String qaSrc = "global";
    if (qaProv == null && qaLlm == null && qaVlm == null && qaMod == null && series != null) {
      qaProv = series.getQaProvider();
      qaLlm = series.getQaLlmModel();
      qaVlm = series.getQaVlmModel();
      qaMod = series.getQaMode();
      qaSrc = "series";
    }
    if (qaProv == null && qaLlm == null && qaVlm == null && qaMod == null) {
      qaProv = gQaProvider;
      qaLlm = gQaLlmModel;
      qaVlm = gQaVlmModel;
      qaMod = gQaMode;
      qaSrc = "global";
    } else if (c.getQaProvider() != null || c.getQaLlmModel() != null || c.getQaVlmModel() != null || c.getQaMode() != null) {
      qaSrc = "chapter";
    }
    var resolvedQa = new ChapterDto.ResolvedQaSlot(qaProv, qaLlm, qaVlm, qaMod, qaSrc);

    return new ChapterDto(
      c.getId(),
      c.getSeries() != null ? c.getSeries().getId() : null,
      c.getChapterNumber(),
      c.getTitle(),
      c.getCoverImageId() != null ? getImageUrl(c.getCoverImageId()) : null,
      c.getOcrProvider(),
      c.getOcrModel(),
      c.getTlProvider(),
      c.getTlModel(),
      c.getQaProvider(),
      c.getQaLlmModel(),
      c.getQaVlmModel(),
      c.getQaMode(),
      c.getRoutingStrategy(),
      c.getUseContextMemory(),
      c.getUseFallbackModels(),
      (int) pageRepository.countByChapterId(c.getId()),
      c.getCreatedAt(),
      c.getUpdatedAt(),
      resolvedOcr,
      resolvedTranslation,
      resolvedQa
    );
  }"""
content = re.sub(populate_method, new_populate_method, content, flags=re.DOTALL)

# Update calls to populateChapterDto
content = re.sub(r'ChapterDto dto = new ChapterDto\(\);\n\s*populateChapterDto\(dto, (.*?), (.*?)\);', r'ChapterDto dto = toChapterDto(\1, \2);', content)

with open(file_path, "w") as f:
    f.write(content)


file_path = "src/main/java/com/manga/library/controller/PageController.java"
with open(file_path, "r") as f:
    content = f.read()

# Fix PageDto
page_dto = r"""  public ResponseEntity<List<PageDto>> listPages\(@PathVariable UUID chapterId\) \{
    List<PageDto> list =
        pageRepository.findByChapterIdOrderByPageNumberAsc\(chapterId\)\.stream\(\)
            \.map\(
                p -> \{
                  PageDto dto = new PageDto\(\);
                  dto\.setId\(p\.getId\(\)\);
                  dto\.setPageNumber\(p\.getPageNumber\(\)\);
                  dto\.setImageId\(p\.getImage\(\)\.getId\(\)\);
                  dto\.setChapterId\(p\.getChapter\(\)\.getId\(\)\);
                  dto\.setFilename\(p\.getImage\(\)\.getFilename\(\)\);
                  dto\.setUrl\(getImageUrl\(p\.getImage\(\)\.getId\(\)\)\);
                  if \(p\.getImage\(\)\.getThumbnailStoragePath\(\) != null\) \{
                    dto\.setThumbnailUrl\(getThumbnailUrl\(p\.getImage\(\)\.getId\(\)\)\);
                  \}
                  return dto;
                \}\)
            \.collect\(Collectors\.toList\(\)\);
    return ResponseEntity\.ok\(list\);
  \}"""
new_page_dto = """  public ResponseEntity<List<PageDto>> listPages(@PathVariable UUID chapterId) {
    List<PageDto> list =
        pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId).stream()
            .map(
                p -> new PageDto(
                  p.getId(),
                  p.getPageNumber(),
                  p.getImage().getId(),
                  p.getChapter().getId(),
                  p.getImage().getFilename(),
                  getImageUrl(p.getImage().getId()),
                  p.getImage().getThumbnailStoragePath() != null ? getThumbnailUrl(p.getImage().getId()) : null
                ))
            .collect(Collectors.toList());
    return ResponseEntity.ok(list);
  }"""
content = re.sub(page_dto, new_page_dto, content, flags=re.DOTALL)

with open(file_path, "w") as f:
    f.write(content)

