import re

log_path = "/home/sagnik/.gemini/antigravity-ide/brain/fd030916-f80b-4e45-b740-8718d80315b8/.system_generated/tasks/task-201.log"
with open(log_path, "r") as f:
    log_content = f.read()

# Pattern to find compile errors. We need to handle newlines in the filepath,
# which are often caused by terminal output wrapping.
# We'll just remove newlines from the log content before searching, 
# but it might mess up line numbers if the line number is on a new line.
# Actually, the maven output format:
# [ERROR] /home/sagnik/Projects/docker-composes/manga-library/backend/src/main/jav
# a/com/manga/library/service/JobCoordinatorService.java:[473,30] cannot find symb
# ol

log_content = log_content.replace('\n', '')

error_pattern = re.compile(
    r'\[ERROR\]\s*(/home/sagnik/[^:]+\.java):\[(\d+),\d+\]\s*cannot find symbol.*?\[ERROR\]\s*symbol:\s*method\s*get([A-Z]\w+)\(\)'
)

fixes = {}

for match in error_pattern.finditer(log_content):
    # Remove any stray spaces/brackets from the filepath that got caught
    filepath = match.group(1).replace(' ', '')
    # Remove Maven's redundant '[ERROR]' strings inside the path if it wrapped weirdly
    filepath = re.sub(r'\[ERROR\]', '', filepath)
    
    line_num = int(match.group(2))
    prop_name = match.group(3)
    
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
                    old_str = f"get{prop}()"
                    new_str = f"{prop[0].lower()}{prop[1:]}()"
                    line = line.replace(old_str, new_str)
                lines[line_idx] = line
                
        with open(filepath, "w") as f:
            f.writelines(lines)
            
        print(f"Fixed {len(line_fixes)} lines in {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")
