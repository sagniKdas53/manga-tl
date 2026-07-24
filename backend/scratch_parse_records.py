import os
import re
import json

dto_dir = "src/main/java/com/manga/library/dto"
records = {}

for root, _, files in os.walk(dto_dir):
    for file in files:
        if file.endswith(".java"):
            filepath = os.path.join(root, file)
            with open(filepath, "r") as f:
                content = f.read()
            
            # Find record definitions
            # e.g., public record SeriesDto(UUID id, String title, ...)
            match = re.search(r'record\s+([A-Za-z0-9_]+)\s*\((.*?)\)', content, re.DOTALL)
            if match:
                name = match.group(1)
                args_str = match.group(2)
                
                # Split args by comma, but be careful with generics like List<String>
                # A simple split by comma might fail if there are commas in generics.
                # Since these are simple DTOs, generics usually don't have commas (e.g. List<PanelData>).
                # Let's split by comma and clean up.
                args = []
                for part in args_str.split(','):
                    part = part.strip()
                    if part:
                        # part is like: "UUID id" or "@NotBlank String title"
                        # extract the last word as the field name, second to last as type
                        tokens = part.split()
                        field_name = tokens[-1]
                        field_type = tokens[-2]
                        args.append({"name": field_name, "type": field_type})
                
                records[name] = args
                
                # also look for nested records like public record ResolvedModelSlot(...)
                nested_matches = re.finditer(r'record\s+([A-Za-z0-9_]+)\s*\((.*?)\)', content, re.DOTALL)
                for nm in nested_matches:
                    n_name = nm.group(1)
                    if n_name != name:
                        n_args_str = nm.group(2)
                        n_args = []
                        for part in n_args_str.split(','):
                            part = part.strip()
                            if part:
                                tokens = part.split()
                                field_name = tokens[-1]
                                field_type = tokens[-2]
                                n_args.append({"name": field_name, "type": field_type})
                        records[n_name] = n_args

print(json.dumps(records, indent=2))
