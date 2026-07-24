import os
import re

test_dir = "src/test/java/com/manga/library"

def process_file(filepath):
    with open(filepath, "r") as f:
        content = f.read()

    # We need to replace Class.builder().prop1(val1)...build()
    # Since .build() might be nested (e.g. .series(Series.builder().build())), we must be careful.
    # Actually, a simpler way is to just replace .builder() with new Object(), and chained calls with nothing if we can.
    # But double brace initialization works:
    # SomeClass.builder().id(val).build() -> new SomeClass() {{ setId(val); }}
    
    # Let's find innermost builders first.
    changed = True
    while changed:
        changed = False
        # Match something like: ClassName.builder() followed by any number of .prop(val) ending with .build()
        # We need to match without crossing another .builder()
        pattern = r'([a-zA-Z0-9_.]+)\.builder\(\)((?:(?!\.builder\(\)).)*?)\.build\(\)'
        
        def repl(m):
            cls = m.group(1)
            props_str = m.group(2)
            
            # parse .prop(val)
            prop_pattern = r'\.([a-zA-Z0-9_]+)\((.*?)\)(?=\s*\.[a-zA-Z0-9_]+\(|\s*$)'
            
            # actually it's easier: split by '.' but we might have '.' inside values
            # let's just do a greedy parse from the end or just write a simple parser
            
            # simple parser for method calls
            props = []
            rest = props_str.strip()
            while rest.startswith('.'):
                rest = rest[1:] # remove '.'
                paren_idx = rest.find('(')
                if paren_idx == -1: break
                method_name = rest[:paren_idx]
                
                # find matching closing paren
                depth = 0
                val_end = -1
                for i in range(paren_idx, len(rest)):
                    if rest[i] == '(': depth += 1
                    elif rest[i] == ')':
                        depth -= 1
                        if depth == 0:
                            val_end = i
                            break
                if val_end != -1:
                    val = rest[paren_idx+1:val_end]
                    props.append((method_name, val))
                    rest = rest[val_end+1:].strip()
                else:
                    break
            
            setters = []
            for k, v in props:
                setter_name = "set" + k[0].upper() + k[1:]
                setters.append(f"{setter_name}({v});")
            
            if setters:
                return f"new {cls}() {{{{ {' '.join(setters)} }}}}"
            else:
                return f"new {cls}()"

        new_content, count = re.subn(pattern, repl, content, flags=re.DOTALL)
        if count > 0:
            content = new_content
            changed = True
            
    # Also fix PanelCallbackDto new PanelCallbackDto() -> new PanelCallbackDto(null, null, null)
    # wait, in tests they did new PanelCallbackDto() and then dto.setImageId(...)
    # Let's replace `PanelCallbackDto dto = new PanelCallbackDto(); dto.setImageId(X);`
    
    with open(filepath, "w") as f:
        f.write(content)

for root, _, files in os.walk(test_dir):
    for file in files:
        if file.endswith(".java"):
            process_file(os.path.join(root, file))

