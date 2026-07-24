import os
import re

models_dir = "/home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/model"

lombok_annotations = [
    "@Data", "@Getter", "@Setter", "@ToString", 
    "@EqualsAndHashCode", "@NoArgsConstructor", 
    "@AllArgsConstructor", "@Builder", "@Value"
]

def capitalize(s):
    return s[0].upper() + s[1:] if s else s

for filename in os.listdir(models_dir):
    if not filename.endswith(".java"):
        continue
    filepath = os.path.join(models_dir, filename)
    with open(filepath, "r") as f:
        content = f.read()
    
    # Remove lombok imports
    content = re.sub(r'import lombok\..*;\n', '', content)
    
    # Remove lombok annotations
    for ann in lombok_annotations:
        content = re.sub(rf'{ann}(\([^)]*\))?\n', '', content)
    
    # Find all fields
    # simple heuristic: private [type] [name]; (could have annotations above)
    # let's look for "private Type name;" or "private Type name = ...;"
    field_pattern = r'private\s+(?:static\s+)?(?:final\s+)?([\w<>,?\[\]]+)\s+(\w+)(?:\s*=[^;]+)?;'
    fields = re.findall(field_pattern, content)
    
    # Find ID field
    id_field = None
    id_type = None
    # We can assume id field is annotated with @Id
    lines = content.split('\n')
    has_id_annotation = False
    for line in lines:
        if "@Id" in line:
            has_id_annotation = True
        elif has_id_annotation and "private" in line:
            m = re.search(r'private\s+([\w<>]+)\s+(\w+)', line)
            if m:
                id_type, id_field = m.groups()
            has_id_annotation = False

    if not id_field:
        # Fallback to finding a field named "id"
        for t, n in fields:
            if n == "id":
                id_type = t
                id_field = n
                break
                
    if not id_field and fields:
        # Fallback to the first field
        id_type = fields[0][0]
        id_field = fields[0][1]

    # Generate getters and setters
    methods = "\n"
    for type_name, field_name in fields:
        if "static" in content[content.find(field_name)-20:content.find(field_name)]:
            continue # naive skip
            
        cap_name = capitalize(field_name)
        
        # Getter
        methods += f"  public {type_name} get{cap_name}() {{\n    return this.{field_name};\n  }}\n\n"
        
        # Setter
        methods += f"  public void set{cap_name}({type_name} {field_name}) {{\n    this.{field_name} = {field_name};\n  }}\n\n"
        
    # Generate equals and hashcode based on ID
    class_name = filename.split(".")[0]
    if id_field:
        methods += f"""  @Override
  public boolean equals(Object o) {{
    if (this == o) return true;
    if (!(o instanceof {class_name})) return false;
    {class_name} that = ({class_name}) o;
    return {id_field} != null && {id_field}.equals(that.get{capitalize(id_field)}());
  }}

  @Override
  public int hashCode() {{
    return getClass().hashCode();
  }}
"""

    # We need to add no args constructor manually if it was there and it's JPA entity
    if "@Entity" in content:
        # Check if constructor exists
        if f"public {class_name}()" not in content and f"protected {class_name}()" not in content:
            methods = f"\n  public {class_name}() {{}}\n" + methods
            
    # Insert before the last closing brace
    last_brace_idx = content.rfind('}')
    if last_brace_idx != -1:
        content = content[:last_brace_idx] + methods + "}\n"
        
    with open(filepath, "w") as f:
        f.write(content)
