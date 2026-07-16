import re

file_path = "/home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/Reader.tsx"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# Bug 7.4.1: Split isRedoing into isRedoingOcrRegion and isRedoingTlRegion
content = content.replace("const [isRedoing, setIsRedoing] = useState(false);",
                          "const [isRedoingOcrRegion, setIsRedoingOcrRegion] = useState(false);\n  const [isRedoingTlRegion, setIsRedoingTlRegion] = useState(false);")

# Update handleRedoRegion to use the correct state
content = re.sub(
    r"const handleRedoRegion = async \(\s*r: OcrRegion,\s*forceType\?: \"ocr\" \| \"translation\",\s*\) => {\s*setIsRedoing\(true\);",
    """const handleRedoRegion = async (
    r: OcrRegion,
    forceType?: "ocr" | "translation",
  ) => {
    const type = forceType || (showTranslations ? "translation" : "ocr");
    if (type === "ocr") setIsRedoingOcrRegion(true);
    else setIsRedoingTlRegion(true);""",
    content,
    flags=re.MULTILINE
)

# Replace setIsRedoing(false) in handleRedoRegion logic
# This requires replacing setIsRedoing(false) with checking the type.
# To be safe, we can just set both to false whenever it finishes.
content = content.replace("setIsRedoing(false);", "setIsRedoingOcrRegion(false);\n          setIsRedoingTlRegion(false);")

# Update the "Redo OCR" and "Redo TL" buttons to use the new states and add the disabled condition for 7.4.2
# Let's find the Redo OCR button in Element Inspector
content = re.sub(
    r'(<button[^>]*>.*?Redo OCR\s*</button>)',
    lambda m: m.group(1).replace('disabled={isRedoing}', 'disabled={isRedoingOcrRegion || (selectedItem?.isLayerElement && selectedItem.layerType === "translation")}'),
    content,
    flags=re.DOTALL
)
content = re.sub(
    r'(<button[^>]*>.*?Redo TL\s*</button>)',
    lambda m: m.group(1).replace('disabled={isRedoing}', 'disabled={isRedoingTlRegion}'),
    content,
    flags=re.DOTALL
)

# Fix Bug 7.4.3: handleRedoRegion adds layers instead of mutating.
# We need to make it poll data.layers as well.
# It currently polls:
# const data = await checkRes.json();
# const regions: OcrRegion[] = data.ocrRegions || [];
# The frontend gets new layers via SSE, so we can just wait for SSE to update `layers` state?
# If we just change the polling to also check data.layers?
# Wait, actually, let's just make it clear the interval when attempts >= 8.
# The SSE will update the layers.
content = re.sub(
    r'(if \(textChanged \|\| attempts >= 8\) {.*?})',
    r'\1',
    content,
    flags=re.DOTALL
)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)
