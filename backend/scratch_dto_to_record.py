import os
import re

dto_dir = "/home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/dto"

for filename in os.listdir(dto_dir):
    if not filename.endswith(".java"):
        continue
    filepath = os.path.join(dto_dir, filename)
    with open(filepath, "r") as f:
        content = f.read()

    # Remove lombok imports
    content = re.sub(r'import lombok\..*;\n', '', content)
    
    # Remove lombok annotations
    lombok_annotations = [
        r'@Data\n', r'@Builder\n', r'@NoArgsConstructor\n', r'@AllArgsConstructor\n',
        r'@Value\n', r'@Getter\n', r'@Setter\n'
    ]
    for ann in lombok_annotations:
        content = re.sub(ann, '', content)

    # Convert class to record
    class_match = re.search(r'public class (\w+)(.*?)\{', content, re.DOTALL)
    if class_match:
        class_name = class_match.group(1)
        implements_clause = class_match.group(2).strip()
        
        # Extract fields (and any field annotations)
        field_pattern = r'(\s*(?:@[a-zA-Z0-9_.\(\)".\s=\-{},]+\s*)*)\s*private\s+([\w<>,\?\[\]]+)\s+(\w+);'
        fields_found = []
        
        # Find all fields
        for match in re.finditer(field_pattern, content):
            annots = match.group(1).strip()
            type_name = match.group(2)
            name = match.group(3)
            
            # format annotations properly
            annots_str = (annots + " ") if annots else ""
            annots_str = annots_str.replace('\n', ' ')
            annots_str = re.sub(r'\s+', ' ', annots_str)
            
            fields_found.append(f"{annots_str}{type_name} {name}")
            
        fields_str = ",\n  ".join(fields_found)
        
        # Remove old fields from body
        body = content[class_match.end():]
        body = re.sub(field_pattern, '', body)
        
        # reconstruct class
        new_header = f"public record {class_name}(\n  {fields_str}\n){' ' + implements_clause if implements_clause else ''} {{"
        content = content[:class_match.start()] + new_header + body
        
        with open(filepath, "w") as f:
            f.write(content)
