package com.manga.library.config;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;

public class DockerSecretsEnvironmentPostProcessor implements EnvironmentPostProcessor {
    private static final Logger logger = LoggerFactory.getLogger(DockerSecretsEnvironmentPostProcessor.class);

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        Map<String, Object> secretsMap = new HashMap<>();

        // Process DOCKER_SECRETS_JSON
        String jsonPath = System.getenv("DOCKER_SECRETS_JSON");
        if (jsonPath != null && !jsonPath.isEmpty()) {
            File jsonFile = new File(jsonPath);
            if (jsonFile.exists()) {
                try {
                    ObjectMapper mapper = new ObjectMapper();
                    Map<String, Object> jsonSecrets = mapper.readValue(jsonFile, new TypeReference<Map<String, Object>>() {});
                    secretsMap.putAll(jsonSecrets);
                    logger.info("Loaded secrets from DOCKER_SECRETS_JSON: {}", jsonPath);
                } catch (Exception e) {
                    logger.error("Failed to read JSON secrets from " + jsonPath, e);
                }
            }
        }

        // Process _FILE variables
        for (Map.Entry<String, String> entry : System.getenv().entrySet()) {
            String key = entry.getKey();
            if (key.endsWith("_FILE")) {
                String realKey = key.substring(0, key.length() - 5);
                String filePath = entry.getValue();
                
                // Don't overwrite if DOCKER_SECRETS_JSON already provided it
                if (!secretsMap.containsKey(realKey)) {
                    File secretFile = new File(filePath);
                    if (secretFile.exists()) {
                        try {
                            String content = new String(Files.readAllBytes(secretFile.toPath())).trim();
                            secretsMap.put(realKey, content);
                            logger.info("Loaded secret for {} from file {}", realKey, filePath);
                        } catch (IOException e) {
                            logger.error("Failed to read secret file from " + filePath, e);
                        }
                    }
                }
            }
        }

        if (!secretsMap.isEmpty()) {
            environment.getPropertySources().addFirst(new MapPropertySource("dockerSecrets", secretsMap));
        }
    }
}
