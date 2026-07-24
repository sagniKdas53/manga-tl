import os
import re

conv_reg_file = "src/main/java/com/manga/library/model/ConversationRegion.java"
with open(conv_reg_file, "r") as f:
    content = f.read()

# Instead of getters, just suppress PMD for the fields
content = re.sub(r'(private UUID conversationId;)', r'@SuppressWarnings("PMD.UnusedPrivateField")\n    \1', content)
content = re.sub(r'(private UUID regionId;)', r'@SuppressWarnings("PMD.UnusedPrivateField")\n    \1', content)

with open(conv_reg_file, "w") as f:
    f.write(content)
