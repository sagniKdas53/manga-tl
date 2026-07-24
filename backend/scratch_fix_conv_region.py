import re

file_path = "src/main/java/com/manga/library/model/ConversationRegion.java"
with open(file_path, "r") as f:
    lines = f.readlines()

new_lines = []
skip = False
for i, line in enumerate(lines):
    if line.strip() == "public UUID getConversationId() {" and i > 40:
        skip = True
    
    if line.strip() == "@Override" and skip:
        skip = False
        
    if not skip:
        new_lines.append(line)

with open(file_path, "w") as f:
    f.writelines(new_lines)

