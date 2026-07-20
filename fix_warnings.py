import os
import json
import re

with open('backend/warnings.json', 'r') as f:
    warnings = json.load(f)

test_files = set()
for w in warnings:
    if 'src/test/java' in w['resource'] and 'Unnecessary @SuppressWarnings("unchecked")' in w['message']:
        test_files.add(w['resource'])

for file_path in test_files:
    if not os.path.exists(file_path):
        continue
    with open(file_path, 'r') as f:
        content = f.read()
    
    # Replace @SuppressWarnings({"null", "unchecked"}) -> @SuppressWarnings("null")
    content = re.sub(r'@SuppressWarnings\(\{\s*"null"\s*,\s*"unchecked"\s*\}\)', '@SuppressWarnings("null")', content)
    content = re.sub(r'@SuppressWarnings\(\{\s*"unchecked"\s*,\s*"null"\s*\}\)', '@SuppressWarnings("null")', content)
    # Replace @SuppressWarnings("unchecked") -> @SuppressWarnings("null") (wait, if it was just "unchecked", we should change to "null" as per instructions "Add scoped test-only suppression for JDT null diagnostics in every test class listed by backend/warnings.json.")
    content = re.sub(r'@SuppressWarnings\("unchecked"\)', '@SuppressWarnings("null")', content)
    
    with open(file_path, 'w') as f:
        f.write(content)
print(f"Processed {len(test_files)} test files.")
