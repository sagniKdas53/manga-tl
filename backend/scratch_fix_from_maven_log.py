import re

log_path = "/home/sagnik/.gemini/antigravity-ide/brain/fd030916-f80b-4e45-b740-8718d80315b8/.system_generated/tasks/task-201.log"
with open(log_path, "r") as f:
    log_content = f.read()

# Pattern to find compile errors:
# [ERROR] /path/to/file.java:[line,col] cannot find symbol
# [ERROR]   symbol:   method getSomething()
error_pattern = re.compile(
    r'\[ERROR\]\s+(/home/sagnik/[^:]+\.java):\[(\d+),\d+\]\s+cannot find symbol\s*'
    r'\[ERROR\]\s+symbol:\s+method\s+get([A-Z]\w+)\(\)'
)

fixes = {}

for match in error_pattern.finditer(log_content):
    filepath = match.group(1)
    line_num = int(match.group(2))
    prop_name = match.group(3) # e.g. Confidence
    
    if filepath not in fixes:
        fixes[filepath] = {}
        
    if line_num not in fixes[filepath]:
        fixes[filepath][line_num] = []
        
    fixes[filepath][line_num].append(prop_name)

for filepath, line_fixes in fixes.items():
    try:
        with open(filepath, "r") as f:
            lines = f.readlines()
            
        for line_num, props in line_fixes.items():
            line_idx = line_num - 1
            if line_idx < len(lines):
                line = lines[line_idx]
                for prop in props:
                    # replace getProp() with prop()
                    old_str = f"get{prop}()"
                    new_str = f"{prop[0].lower()}{prop[1:]}()"
                    line = line.replace(old_str, new_str)
                lines[line_idx] = line
                
        with open(filepath, "w") as f:
            f.writelines(lines)
            
        print(f"Fixed {len(line_fixes)} lines in {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")
