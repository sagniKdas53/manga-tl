import os
import re

base_dir = "/home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library"

for root, _, files in os.walk(base_dir):
    for filename in files:
        if not filename.endswith(".java"):
            continue
        filepath = os.path.join(root, filename)
        with open(filepath, "r") as f:
            content = f.read()

        if "lombok" not in content:
            continue

        # Remove lombok imports
        content = re.sub(r'import lombok\..*;\n', '', content)
        
        # Identify class name
        class_match = re.search(r'public class (\w+)(.*?)\{', content)
        if not class_match:
            continue
            
        class_name = class_match.group(1)
        
        # Handle @Slf4j
        if "@Slf4j" in content:
            content = re.sub(r'@Slf4j\n', '', content)
            
            # Need to insert the logger
            # It should go right after the class declaration brace
            logger_decl = f"\n  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger({class_name}.class);\n"
            content = content[:class_match.end()] + logger_decl + content[class_match.end():]
            
            # Add org.slf4j imports if missing
            if "import org.slf4j.Logger;" not in content:
                # insert after package
                content = re.sub(r'(package .*?;)', r'\1\n\nimport org.slf4j.Logger;\nimport org.slf4j.LoggerFactory;', content, count=1)

        # Handle @RequiredArgsConstructor
        if "@RequiredArgsConstructor" in content:
            content = re.sub(r'@RequiredArgsConstructor\n', '', content)
            
            # Find final fields to create constructor
            field_pattern = r'private\s+final\s+([\w<>,\?\[\]]+)\s+(\w+);'
            fields = re.findall(field_pattern, content)
            
            if fields:
                args = ", ".join([f"{t} {n}" for t, n in fields])
                assignments = "\n".join([f"    this.{n} = {n};" for t, n in fields])
                constructor = f"\n  public {class_name}({args}) {{\n{assignments}\n  }}\n"
                
                # Insert constructor after the last field
                # A heuristic: find the last 'private final' and insert after its semicolon
                last_field_match = list(re.finditer(field_pattern, content))[-1]
                content = content[:last_field_match.end()] + constructor + content[last_field_match.end():]
                
        # Handle other lombok annotations just in case (e.g. @Data in components)
        lombok_annotations = [
            r'@Data\n', r'@Builder\n', r'@NoArgsConstructor\n', r'@AllArgsConstructor\n',
            r'@Value\n', r'@Getter\n', r'@Setter\n'
        ]
        for ann in lombok_annotations:
            content = re.sub(ann, '', content)
            
        with open(filepath, "w") as f:
            f.write(content)
