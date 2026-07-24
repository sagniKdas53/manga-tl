import re
import glob
import os

files = [
    "src/main/java/com/manga/library/service/JobCoordinatorService.java",
    "src/main/java/com/manga/library/service/PageService.java",
    "src/main/java/com/manga/library/controller/AuthController.java",
    "src/main/java/com/manga/library/controller/SeriesController.java",
    "src/main/java/com/manga/library/controller/PageController.java",
]

# A regex to find:
# SomeClass varName = SomeClass.builder()
#     .method(arg)
#     ...
#     .build();
#
# This regex is tricky because of arbitrary nesting and whitespace.
# It's better to process the file linearly.

for filepath in files:
    if not os.path.exists(filepath):
        continue
    with open(filepath, "r") as f:
        content = f.read()

    # We will use a state machine to parse the code.
    lines = content.split('\n')
    new_lines = []
    
    in_builder = False
    builder_var_type = ""
    builder_var_name = ""
    builder_statements = []
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        # Check if line contains: Type var = Type.builder()
        # or var = Type.builder()
        # or just Type.builder() inside a method call (harder to parse)
        
        # To make it simpler, we will just use the python script to do 
        # a naive replacement for the most common pattern.
        i += 1
