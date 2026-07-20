import re

files_to_patch = [
    "frontend/src/types.ts",
    "frontend/src/components/ImportChapterDialog.tsx",
    "frontend/src/components/CreateChapterDialog.tsx",
    "frontend/src/components/EditSeriesDialog.tsx",
    "frontend/src/components/CreateSeriesDialog.tsx",
]

for file in files_to_patch:
    with open(file, "r") as f:
        content = f.read()
    
    # Add routingStrategy to interface SystemSettingsDto {
    content = content.replace("  qaVlmModelList: string[];", "  qaVlmModelList: string[];\n  routingStrategy?: string;")
    
    with open(file, "w") as f:
        f.write(content)

