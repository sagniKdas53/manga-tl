import os
import re

base_dir = "/home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library"

for root, _, files in os.walk(base_dir):
    for filename in files:
        if not filename.endswith(".java") or "model" in root or "dto" in root:
            continue
        filepath = os.path.join(root, filename)
        with open(filepath, "r") as f:
            content = f.read()

        if "lombok" not in content and "@Slf4j" not in content and "@RequiredArgsConstructor" not in content:
            continue

        # Use lines to avoid index shifting problems
        lines = content.split('\n')
        new_lines = []
        
        has_slf4j = False
        has_req_args = False
        
        for line in lines:
            if "import lombok" in line:
                continue
            if "@Slf4j" in line:
                has_slf4j = True
                continue
            if "@RequiredArgsConstructor" in line:
                has_req_args = True
                continue
            if "@Data" in line or "@Builder" in line or "@Value" in line:
                continue
            new_lines.append(line)
            
        content = '\n'.join(new_lines)
        
        # Add SLF4J Logger
        if has_slf4j:
            class_match = re.search(r'public class (\w+)(.*?)\{', content)
            if class_match:
                class_name = class_match.group(1)
                logger_decl = f"\n  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger({class_name}.class);\n"
                idx = class_match.end()
                content = content[:idx] + logger_decl + content[idx:]

        # Add RequiredArgsConstructor
        if has_req_args:
            class_match = re.search(r'public class (\w+)(.*?)\{', content)
            if class_match:
                class_name = class_match.group(1)
                field_pattern = r'private\s+final\s+([\w<>,\?\[\]]+)\s+(\w+);'
                fields = re.findall(field_pattern, content)
                
                if fields:
                    args = ", ".join([f"{t} {n}" for t, n in fields])
                    assignments = "\n".join([f"    this.{n} = {n};" for t, n in fields])
                    constructor = f"\n  public {class_name}({args}) {{\n{assignments}\n  }}\n"
                    
                    last_field_match = list(re.finditer(field_pattern, content))[-1]
                    idx = last_field_match.end()
                    content = content[:idx] + constructor + content[idx:]

        with open(filepath, "w") as f:
            f.write(content)
