import os
import re

files_to_edit = {
    'backend/src/test/java/com/manga/library/service/CostEstimationServiceTest.java': [
        r'@SuppressWarnings\("unchecked"\)\s+private <T> T mockGeneric\(Class<\?> clazz\)\s*\{\s*return \(T\) org\.mockito\.Mockito\.mock\(clazz\);\s*\}',
        r'@SuppressWarnings\("unchecked"\)\s+private <T> T anyGeneric\(Class<\?> clazz\)\s*\{\s*return \(T\) org\.mockito\.ArgumentMatchers\.any\(clazz\);\s*\}'
    ],
    'backend/src/test/java/com/manga/library/service/JobCoordinatorServiceTest.java': [
        r'@Autowired private SystemSettingsService systemSettingsService;',
        r'@SuppressWarnings\("unchecked"\)\s+private <T> T mockGeneric\(Class<\?> clazz\)\s*\{\s*return \(T\) org\.mockito\.Mockito\.mock\(clazz\);\s*\}',
        r'@SuppressWarnings\("unchecked"\)\s+private <T> T anyGeneric\(Class<\?> clazz\)\s*\{\s*return \(T\) org\.mockito\.ArgumentMatchers\.any\(clazz\);\s*\}'
    ],
    'backend/src/test/java/com/manga/library/service/PipelineFlowIntegrationTest.java': [
        r'@Autowired private JobCoordinatorService jobCoordinatorService;',
        r'@SuppressWarnings\("unchecked"\)\s+private <T> T anyGeneric\(Class<\?> clazz\)\s*\{\s*return \(T\) org\.mockito\.ArgumentMatchers\.any\(clazz\);\s*\}'
    ],
    'backend/src/test/java/com/manga/library/service/WorkerDispatcherServiceTest.java': [
        r'@SuppressWarnings\("unchecked"\)\s+private <T> T anyGeneric\(Class<\?> clazz\)\s*\{\s*return \(T\) org\.mockito\.ArgumentMatchers\.any\(clazz\);\s*\}'
    ],
    'backend/src/test/java/com/manga/library/service/ChapterExportServiceTest.java': [
        r'private String exportId;'
    ]
}

for file_path, patterns in files_to_edit.items():
    if not os.path.exists(file_path):
        continue
    with open(file_path, 'r') as f:
        content = f.read()
    
    for pattern in patterns:
        content = re.sub(pattern, '', content)
        
    with open(file_path, 'w') as f:
        f.write(content)
print("Removed unused fields and methods.")
