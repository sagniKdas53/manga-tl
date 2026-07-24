import os
import re
import json

with open("scratch_parse_records.py", "r") as f:
    pass # we already ran this and have the json output

# We will just embed the json here from the previous step
records = json.loads("""
{
  "ImageDto": [
    { "name": "id", "type": "UUID" },
    { "name": "filename", "type": "String" },
    { "name": "mimeType", "type": "String" },
    { "name": "size", "type": "Long" },
    { "name": "width", "type": "Integer" },
    { "name": "height", "type": "Integer" },
    { "name": "hash", "type": "String" },
    { "name": "url", "type": "String" },
    { "name": "thumbnailUrl", "type": "String" },
    { "name": "createdAt", "type": "OffsetDateTime" },
    { "name": "updatedAt", "type": "OffsetDateTime" }
  ],
  "JobDto": [
    { "name": "id", "type": "UUID" },
    { "name": "type", "type": "String" },
    { "name": "status", "type": "String" },
    { "name": "priority", "type": "Integer" },
    { "name": "targetId", "type": "UUID" },
    { "name": "targetType", "type": "String" },
    { "name": "progress", "type": "Integer" },
    { "name": "resultData", "type": "String" },
    { "name": "errorMessage", "type": "String" },
    { "name": "createdAt", "type": "OffsetDateTime" },
    { "name": "updatedAt", "type": "OffsetDateTime" },
    { "name": "startedAt", "type": "OffsetDateTime" },
    { "name": "completedAt", "type": "OffsetDateTime" },
    { "name": "cost", "type": "Double" },
    { "name": "totalCost", "type": "Double" },
    { "name": "retryCount", "type": "Integer" },
    { "name": "workerId", "type": "String" },
    { "name": "seriesId", "type": "UUID" }
  ],
  "PanelCallbackDto": [
    { "name": "imageId", "type": "UUID" },
    { "name": "pageId", "type": "UUID" },
    { "name": "panels", "type": "List<PanelData>" }
  ],
  "PanelData": [
    { "name": "x", "type": "Integer" },
    { "name": "y", "type": "Integer" },
    { "name": "width", "type": "Integer" },
    { "name": "height", "type": "Integer" },
    { "name": "readingOrder", "type": "Integer" },
    { "name": "panelId", "type": "String" },
    { "name": "score", "type": "Double" }
  ],
  "ChapterDto": [
    { "name": "id", "type": "UUID" },
    { "name": "seriesId", "type": "UUID" },
    { "name": "chapterNumber", "type": "Double" },
    { "name": "title", "type": "String" },
    { "name": "volume", "type": "String" },
    { "name": "language", "type": "String" },
    { "name": "scanlator", "type": "String" },
    { "name": "status", "type": "String" },
    { "name": "sourceUrl", "type": "String" },
    { "name": "sourceName", "type": "String" },
    { "name": "externalId", "type": "String" },
    { "name": "ocrStatus", "type": "String" },
    { "name": "translationStatus", "type": "String" },
    { "name": "qaStatus", "type": "String" },
    { "name": "ocrRequested", "type": "Boolean" },
    { "name": "translationRequested", "type": "Boolean" },
    { "name": "pageCount", "type": "Integer" },
    { "name": "createdAt", "type": "java.time.OffsetDateTime" },
    { "name": "updatedAt", "type": "java.time.OffsetDateTime" },
    { "name": "resolvedOcrModel", "type": "ResolvedModelSlot" },
    { "name": "resolvedTlModel", "type": "ResolvedModelSlot" },
    { "name": "resolvedQaModel", "type": "ResolvedQaSlot" }
  ],
  "SeriesDto": [
    { "name": "id", "type": "UUID" },
    { "name": "title", "type": "String" },
    { "name": "author", "type": "String" },
    { "name": "description", "type": "String" },
    { "name": "originalLanguage", "type": "String" },
    { "name": "targetLanguage", "type": "String" },
    { "name": "sourceLanguage", "type": "String" },
    { "name": "readingDirection", "type": "String" },
    { "name": "coverImageUrl", "type": "String" },
    { "name": "status", "type": "String" },
    { "name": "rating", "type": "Double" },
    { "name": "nsfw", "type": "Boolean" },
    { "name": "createdAt", "type": "OffsetDateTime" },
    { "name": "updatedAt", "type": "OffsetDateTime" },
    { "name": "ocrVlmModelList", "type": "List<String>" },
    { "name": "tlLlmModelList", "type": "List<String>" },
    { "name": "qaLlmModelList", "type": "List<String>" },
    { "name": "qaVlmModelList", "type": "List<String>" },
    { "name": "ocrProvider", "type": "String" },
    { "name": "ocrModel", "type": "String" },
    { "name": "tlProvider", "type": "String" },
    { "name": "tlModel", "type": "String" },
    { "name": "qaProvider", "type": "String" },
    { "name": "qaLlmModel", "type": "String" },
    { "name": "qaVlmModel", "type": "String" },
    { "name": "qaMode", "type": "String" },
    { "name": "routingStrategy", "type": "String" },
    { "name": "useFallbackModels", "type": "Boolean" }
  ],
  "SystemSettingsDto": [
    { "name": "ocrVlmModelList", "type": "List<String>" },
    { "name": "tlLlmModelList", "type": "List<String>" },
    { "name": "qaLlmModelList", "type": "List<String>" },
    { "name": "qaVlmModelList", "type": "List<String>" },
    { "name": "routingStrategy", "type": "String" },
    { "name": "ocrProvider", "type": "String" },
    { "name": "ocrModel", "type": "String" },
    { "name": "tlProvider", "type": "String" },
    { "name": "tlModel", "type": "String" },
    { "name": "qaProvider", "type": "String" },
    { "name": "qaLlmModel", "type": "String" },
    { "name": "qaVlmModel", "type": "String" },
    { "name": "disableLocalOcr", "type": "boolean" },
    { "name": "localOcrModel", "type": "String" },
    { "name": "disableLocalLlm", "type": "boolean" },
    { "name": "qaMode", "type": "String" },
    { "name": "useFallbackModels", "type": "Boolean" },
    { "name": "activeProviders", "type": "List<String>" },
    { "name": "activeOcrProviders", "type": "List<String>" }
  ],
  "OcrCallbackDto": [
    { "name": "imageId", "type": "UUID" },
    { "name": "pageId", "type": "UUID" },
    { "name": "modelIdentifier", "type": "String" },
    { "name": "confidence", "type": "Double" },
    { "name": "cost", "type": "Object" },
    { "name": "regions", "type": "List<OcrRegionData>" }
  ],
  "OcrRegionData": [
    { "name": "text", "type": "String" },
    { "name": "detectedLanguage", "type": "String" },
    { "name": "confidence", "type": "Double" },
    { "name": "rotation", "type": "Double" },
    { "name": "x", "type": "Integer" },
    { "name": "y", "type": "Integer" },
    { "name": "width", "type": "Integer" },
    { "name": "height", "type": "Integer" },
    { "name": "panelReadingOrder", "type": "Integer" },
    { "name": "bubbleReadingOrder", "type": "Integer" },
    { "name": "conversationGroup", "type": "List<UUID>" },
    { "name": "backgroundColor", "type": "String" },
    { "name": "bubbleX", "type": "Integer" },
    { "name": "bubbleY", "type": "Integer" },
    { "name": "bubbleWidth", "type": "Integer" },
    { "name": "bubbleHeight", "type": "Integer" },
    { "name": "bubbleId", "type": "String" },
    { "name": "detectionConfidence", "type": "Double" },
    { "name": "maskPolygon", "type": "String" },
    { "name": "safeTextX", "type": "Integer" },
    { "name": "safeTextY", "type": "Integer" },
    { "name": "safeTextW", "type": "Integer" },
    { "name": "safeTextH", "type": "Integer" }
  ]
}
""")

def extract_setters(lines, var_name):
    setters = {}
    setter_pattern = re.compile(rf'^\s*{var_name}\.set([a-zA-Z0-9_]+)\((.*)\);\s*$')
    remaining_lines = []
    for line in lines:
        m = setter_pattern.match(line)
        if m:
            field_name = m.group(1)
            # lowerCamelCase
            field_name = field_name[0].lower() + field_name[1:]
            val = m.group(2)
            setters[field_name] = val
        else:
            remaining_lines.append(line)
    return setters, remaining_lines

def process_file(filepath):
    with open(filepath, "r") as f:
        content = f.read()
        
    lines = content.split('\n')
    
    # 1. Replace dto.getSomething() -> dto.something()
    # But ONLY for DTO types. We don't want to break entity getters.
    # To be safe, we will regex replace `dto.get([A-Z][a-zA-Z0-9]+)\(\)` when we know the variable is a DTO.
    # We will do a generic replacement of `.get([A-Z][a-zA-Z0-9]*)\(\)` to `.\1()` if it's called on a DTO variable.
    # DTO variables we know from tests: `dto`, `seriesDto`, `ch1Dto`, `ch2Dto`, `panelCallback`, `ocrCallback`, `ocrCallback2`, `savedSeries`, `savedCh1`, `savedCh2`, `settings`, `updateDto`
    dto_vars = ['dto', 'seriesDto', 'ch1Dto', 'ch2Dto', 'panelCallback', 'ocrCallback', 'ocrCallback2', 'savedSeries', 'savedCh1', 'savedCh2', 'settings', 'updateDto', 'ocrRegion2']
    
    for var in dto_vars:
        pattern = rf'{var}\.get([A-Z][a-zA-Z0-9]*)\(\)'
        def repl_getter(m):
            prop = m.group(1)
            prop = prop[0].lower() + prop[1:]
            return f"{var}.{prop}()"
        content = re.sub(pattern, repl_getter, content)
        
    lines = content.split('\n')
        
    # 2. Replace new Dto() + setters
    # we iterate line by line, if we find `DtoType var = new DtoType();` we consume setters.
    i = 0
    new_lines = []
    while i < len(lines):
        line = lines[i]
        m = re.search(r'([A-Za-z0-9_]+Dto(?:\.OcrRegionData)?)\s+([A-Za-z0-9_]+)\s*=\s*new\s+\1\(\);', line)
        if m:
            dto_type = m.group(1)
            var_name = m.group(2)
            if dto_type.startswith("OcrCallbackDto.OcrRegionData"):
                dto_type = "OcrRegionData"
            
            if dto_type in records:
                # collect setters until an empty line or something else
                j = i + 1
                setters = {}
                setter_pattern = re.compile(rf'^\s*{var_name}\.set([a-zA-Z0-9_]+)\((.*)\);\s*$')
                while j < len(lines):
                    next_line = lines[j]
                    if next_line.strip() == "":
                        j += 1
                        continue
                    m_setter = setter_pattern.match(next_line)
                    if m_setter:
                        f_name = m_setter.group(1)
                        f_name = f_name[0].lower() + f_name[1:]
                        f_val = m_setter.group(2)
                        setters[f_name] = f_val
                        j += 1
                    else:
                        break
                
                # construct the new Dto instantiation
                record_fields = records[dto_type]
                args = []
                for f in record_fields:
                    args.append(setters.get(f["name"], "null"))
                
                # create string
                arg_str = ", ".join(args)
                new_line = line[:m.start()] + f"{m.group(1)} {var_name} = new {m.group(1)}({arg_str});" + line[m.end():]
                new_lines.append(new_line)
                i = j
                continue
        new_lines.append(line)
        i += 1
        
    with open(filepath, "w") as f:
        f.write('\n'.join(new_lines))

for root, _, files in os.walk("src/test/java"):
    for file in files:
        if file.endswith(".java"):
            process_file(os.path.join(root, file))

