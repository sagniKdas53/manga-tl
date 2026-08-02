package com.manga.library.config;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import org.apache.commons.logging.Log;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.boot.logging.DeferredLogFactory;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Materialises Docker secrets into the Spring {@link org.springframework.core.env.Environment},
 * from either a {@code DOCKER_SECRETS_JSON} bundle or individual {@code *_FILE} variables.
 *
 * <p>Every path that fails to yield a secret now logs at WARN or ERROR (AUDIT-S1). It previously
 * skipped a missing file in silence, so a bad mount produced a running application authenticating
 * on {@code application.yml}'s hardcoded fallbacks with nothing in the log to say so. Those
 * fallbacks are gone and {@link SecretsStartupValidator} halts startup instead, but the warning is
 * what tells an operator *which* mount is wrong.
 */
public class DockerSecretsEnvironmentPostProcessor implements EnvironmentPostProcessor {

  private static final String FILE_SUFFIX = "_FILE";

  private final Log logger;

  /**
   * @param logFactory supplied by Spring Boot. Environment post-processing runs before the logging
   *     system is initialised, so a plain SLF4J logger here would write into a void; a deferred log
   *     is replayed once logging comes up.
   */
  public DockerSecretsEnvironmentPostProcessor(DeferredLogFactory logFactory) {
    this.logger = logFactory.getLog(DockerSecretsEnvironmentPostProcessor.class);
  }

  @Override
  public void postProcessEnvironment(
      ConfigurableEnvironment environment, SpringApplication application) {
    Map<String, Object> secretsMap = new HashMap<>();

    loadSecretsBundle(secretsMap);
    loadSecretFiles(secretsMap);

    if (!secretsMap.isEmpty()) {
      environment.getPropertySources().addFirst(new MapPropertySource("dockerSecrets", secretsMap));
    }
  }

  private void loadSecretsBundle(Map<String, Object> secretsMap) {
    String jsonPath = System.getenv("DOCKER_SECRETS_JSON");
    if (jsonPath == null || jsonPath.isEmpty()) {
      return;
    }
    File jsonFile = new File(jsonPath);
    if (!jsonFile.exists()) {
      logger.warn(
          "DOCKER_SECRETS_JSON points at "
              + jsonPath
              + ", which does not exist. No secrets were loaded from it.");
      return;
    }
    try {
      ObjectMapper mapper = new ObjectMapper();
      Map<String, Object> jsonSecrets =
          mapper.readValue(jsonFile, new TypeReference<Map<String, Object>>() {});
      secretsMap.putAll(jsonSecrets);
      logger.info("Loaded " + jsonSecrets.size() + " secrets from DOCKER_SECRETS_JSON: " + jsonPath);
    } catch (Exception e) {
      logger.error("Failed to read JSON secrets from " + jsonPath, e);
    }
  }

  private void loadSecretFiles(Map<String, Object> secretsMap) {
    for (Map.Entry<String, String> entry : System.getenv().entrySet()) {
      String key = entry.getKey();
      if (!key.endsWith(FILE_SUFFIX)) {
        continue;
      }
      String realKey = key.substring(0, key.length() - FILE_SUFFIX.length());
      // Don't overwrite if DOCKER_SECRETS_JSON already provided it.
      if (secretsMap.containsKey(realKey)) {
        continue;
      }
      readSecretFile(key, realKey, entry.getValue(), secretsMap);
    }
  }

  private void readSecretFile(
      String envVar, String realKey, String filePath, Map<String, Object> secretsMap) {
    File secretFile = new File(filePath);
    if (!secretFile.exists()) {
      logger.warn(
          envVar
              + " points at "
              + filePath
              + ", which does not exist. "
              + realKey
              + " will be unset — check that the secret is mounted into the container.");
      return;
    }
    try {
      String content =
          new String(Files.readAllBytes(secretFile.toPath()), StandardCharsets.UTF_8).trim();
      if (content.isEmpty()) {
        logger.warn(
            envVar + " points at " + filePath + ", which is empty. " + realKey + " will be unset.");
        return;
      }
      secretsMap.put(realKey, content);
      logger.info("Loaded secret for " + realKey + " from file " + filePath);
    } catch (IOException e) {
      logger.error("Failed to read secret file from " + filePath, e);
    }
  }
}
