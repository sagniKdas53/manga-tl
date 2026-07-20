import re

with open("backend/src/main/java/com/manga/library/service/JobCoordinatorService.java", "r") as f:
    content = f.read()

# Add imports
import_insert = """import com.manga.library.model.JobCost;
import com.manga.library.repository.JobCostRepository;"""

content = content.replace("import com.manga.library.model.Job;", import_insert + "\nimport com.manga.library.model.Job;")

# Add the JobCostRepository injection
inject_find = """  private final SystemSettingRepository systemSettingRepository;"""
inject_replace = """  private final SystemSettingRepository systemSettingRepository;
  private final JobCostRepository jobCostRepository;"""

content = content.replace(inject_find, inject_replace)

# Helper method to parse and save cost
helper_method = """  private void saveJobCosts(UUID imageId, Map<String, Object> costMap) {
    if (costMap == null || costMap.isEmpty()) return;
    try {
      if (costMap.containsKey("breakdown") && costMap.get("breakdown") instanceof List) {
        List<Map<String, Object>> breakdown = (List<Map<String, Object>>) costMap.get("breakdown");
        for (Map<String, Object> c : breakdown) {
          JobCost jc = new JobCost();
          jc.setImageId(imageId);
          if (c.get("provider") != null) jc.setProvider(c.get("provider").toString());
          if (c.get("model") != null) jc.setModel(c.get("model").toString());
          if (c.get("prompt_tokens") != null) jc.setPromptTokens(((Number) c.get("prompt_tokens")).intValue());
          if (c.get("completion_tokens") != null) jc.setCompletionTokens(((Number) c.get("completion_tokens")).intValue());
          if (c.get("estimated_cost") != null) jc.setEstimatedCost(((Number) c.get("estimated_cost")).doubleValue());
          jobCostRepository.save(jc);
        }
      } else if (costMap.containsKey("estimated_cost")) {
          JobCost jc = new JobCost();
          jc.setImageId(imageId);
          if (costMap.get("provider") != null) jc.setProvider(costMap.get("provider").toString());
          if (costMap.get("model") != null) jc.setModel(costMap.get("model").toString());
          if (costMap.get("prompt_tokens") != null) jc.setPromptTokens(((Number) costMap.get("prompt_tokens")).intValue());
          if (costMap.get("completion_tokens") != null) jc.setCompletionTokens(((Number) costMap.get("completion_tokens")).intValue());
          if (costMap.get("estimated_cost") != null) jc.setEstimatedCost(((Number) costMap.get("estimated_cost")).doubleValue());
          jobCostRepository.save(jc);
      }
    } catch (Exception e) {
      log.error("Error saving job costs for image " + imageId, e);
    }
  }
"""

# Insert helper method before handleOcrCallback
idx = content.find("  public String handleOcrCallback")
content = content[:idx] + helper_method + "\n" + content[idx:]

# In handleOcrCallback
idx = content.find("      metadata.set(\"cost\", objectMapper.valueToTree(dto.getCost()));")
if idx != -1:
    cost_insert = "      metadata.set(\"cost\", objectMapper.valueToTree(dto.getCost()));\n      if (dto.getCost() instanceof Map) {\n        saveJobCosts(imageId, (Map<String, Object>) dto.getCost());\n      }"
    content = content[:idx] + cost_insert + content[idx + len("      metadata.set(\"cost\", objectMapper.valueToTree(dto.getCost()));"):]

# In handleTranslationCallback
idx = content.find("    if (cost != null) {\n      tlNode.set(\"cost\", objectMapper.valueToTree(cost));")
if idx != -1:
    content = content.replace("    if (cost != null) {\n      tlNode.set(\"cost\", objectMapper.valueToTree(cost));", "    if (cost != null) {\n      tlNode.set(\"cost\", objectMapper.valueToTree(cost));\n      saveJobCosts(imageId, cost);")

# In handleQaCallback
idx = content.find("          if (cost != null) {\n            qaNode.set(\"cost\", objectMapper.valueToTree(cost));")
if idx != -1:
    content = content.replace("          if (cost != null) {\n            qaNode.set(\"cost\", objectMapper.valueToTree(cost));", "          if (cost != null) {\n            qaNode.set(\"cost\", objectMapper.valueToTree(cost));\n            saveJobCosts(imageId, cost);")

with open("backend/src/main/java/com/manga/library/service/JobCoordinatorService.java", "w") as f:
    f.write(content)
