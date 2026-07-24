import os
import re

dto_dir = "/home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/dto"

lombok_annotations = [
    r'@Data\n', r'@Builder\n', r'@NoArgsConstructor\n', r'@AllArgsConstructor\n',
    r'@Value\n', r'@Getter\n', r'@Setter\n'
]

for filename in os.listdir(dto_dir):
    if not filename.endswith(".java"):
        continue
    filepath = os.path.join(dto_dir, filename)
    with open(filepath, "r") as f:
        content = f.read()

    # Remove lombok imports
    content = re.sub(r'import lombok\..*;\n', '', content)
    
    # Remove lombok annotations
    for ann in lombok_annotations:
        content = re.sub(ann, '', content)

    # Let's use a simpler approach: we parse class blocks
    # This is a basic Java parser
    def convert_to_record(class_body_text):
        class_pattern = r'(public\s+(?:static\s+)?class\s+(\w+)(.*?))\{'
        match = re.search(class_pattern, class_body_text, re.DOTALL)
        if not match:
            return class_body_text
            
        full_match = match.group(1)
        class_name = match.group(2)
        implements_clause = match.group(3).strip()
        
        # Now find fields inside this class level
        # We need to find `private type name;`
        # But only top level fields (not in methods or inner classes)
        # Instead of parsing everything, let's just find all private fields.
        # Since it's a DTO, usually there are only fields and inner classes.
        
        # We can extract the inner classes first, convert them, and replace them
        inner_class_pattern = r'(public\s+static\s+class\s+\w+.*?\{)'
        
        # It's getting too complicated to write a robust parser.
        # I'll just skip ChapterDto and OcrCallbackDto and do them manually.
        
        return class_body_text

    if filename not in ["ChapterDto.java", "OcrCallbackDto.java", "PanelCallbackDto.java"]:
        # Use previous simple regex
        class_match = re.search(r'public class (\w+)(.*?)\{', content, re.DOTALL)
        if class_match:
            class_name = class_match.group(1)
            implements_clause = class_match.group(2).strip()
            field_pattern = r'(\s*(?:@[a-zA-Z0-9_.\(\)".\s=\-{},]+\s*)*)\s*private\s+([\w<>,\?\[\]]+)\s+(\w+);'
            fields_found = []
            for match in re.finditer(field_pattern, content):
                annots = match.group(1).strip()
                type_name = match.group(2)
                name = match.group(3)
                annots_str = (annots + " ") if annots else ""
                annots_str = annots_str.replace('\n', ' ')
                annots_str = re.sub(r'\s+', ' ', annots_str)
                fields_found.append(f"{annots_str}{type_name} {name}")
                
            fields_str = ",\n  ".join(fields_found)
            body = content[class_match.end():]
            body = re.sub(field_pattern, '', body)
            new_header = f"public record {class_name}(\n  {fields_str}\n){' ' + implements_clause if implements_clause else ''} {{"
            content = content[:class_match.start()] + new_header + body
            
            with open(filepath, "w") as f:
                f.write(content)
