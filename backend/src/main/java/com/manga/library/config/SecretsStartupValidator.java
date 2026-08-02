package com.manga.library.config;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Fails application startup when an authentication secret is missing or is a known-public
 * development value (AUDIT-S1 / AUDIT-S2).
 *
 * <p>Before this existed, {@code application.yml} shipped working fallbacks for both {@code
 * jwt.secret} and {@code internal.api-token}. The JWT fallback was a verbatim copy of a widely
 * published tutorial key, so anyone holding it could mint a token for any user and role. Combined
 * with {@link DockerSecretsEnvironmentPostProcessor} silently continuing past an unreadable secret
 * file, a misconfigured deployment booted on that key without a single log line saying so.
 *
 * <p>The rule is therefore fail-closed: no secret, no startup. Development values live in {@code
 * application-local.yml} and are only tolerated while a development profile is active.
 */
// final: the constructor throws on a bad configuration, and a non-final class that throws part-way
// through construction can be subclassed to expose the partially-initialised object (SpotBugs
// CT_CONSTRUCTOR_THROW).
@Component
public final class SecretsStartupValidator {

  private static final Logger logger = LoggerFactory.getLogger(SecretsStartupValidator.class);

  /** Profiles under which the placeholder development secrets are acceptable. */
  static final Set<String> DEVELOPMENT_PROFILES = Set.of("local", "test", "integration");

  /**
   * Values that must never authenticate anything outside development. The first two are the
   * fallbacks this codebase used to ship; the rest are the placeholders in {@code
   * application-local.yml}.
   */
  static final Set<String> KNOWN_INSECURE_SECRETS =
      Set.of(
          "5367566b59703373367639792f423f4528482b4d6251655468576d5a71347437",
          "manga-library-internal-token-12345",
          "dev-only-insecure-jwt-secret-do-not-use-in-production-0000000000",
          "dev-only-insecure-internal-token-do-not-use-in-production",
          "changeme",
          "secret");

  /** HS256 signing keys must carry at least 256 bits of material. */
  static final int MIN_JWT_SECRET_LENGTH = 32;

  static final int MIN_INTERNAL_TOKEN_LENGTH = 16;

  public SecretsStartupValidator(
      Environment environment,
      @Value("${jwt.secret:}") String jwtSecret,
      @Value("${internal.api-token:}") String internalApiToken) {
    validate(isDevelopment(environment.getActiveProfiles()), jwtSecret, internalApiToken);
  }

  static boolean isDevelopment(String[] activeProfiles) {
    return Arrays.stream(activeProfiles).anyMatch(DEVELOPMENT_PROFILES::contains);
  }

  /**
   * @throws IllegalStateException if any secret is unusable, listing every problem at once so a
   *     misconfigured deployment is fixed in one pass rather than one restart per secret.
   */
  static void validate(boolean development, String jwtSecret, String internalApiToken) {
    List<String> problems = new ArrayList<>();
    problems.addAll(
        check("JWT_SECRET", "jwt.secret", jwtSecret, MIN_JWT_SECRET_LENGTH, development));
    problems.addAll(
        check(
            "INTERNAL_API_TOKEN",
            "internal.api-token",
            internalApiToken,
            MIN_INTERNAL_TOKEN_LENGTH,
            development));

    if (!problems.isEmpty()) {
      throw new IllegalStateException(
          "Refusing to start: "
              + String.join(" ", problems)
              + " Provide the secrets via Docker secrets (*_FILE) or environment variables, "
              + "or activate the 'local' profile for development.");
    }

    if (development) {
      logger.warn(
          "Development profile active: authentication secrets are not being checked against the "
              + "known-insecure list. Never run this configuration in production.");
    }
  }

  private static List<String> check(
      String envVar, String property, String value, int minLength, boolean development) {
    List<String> problems = new ArrayList<>();
    String trimmed = value == null ? "" : value.trim();

    if (trimmed.isEmpty()) {
      problems.add(envVar + " (" + property + ") is not set.");
      return problems;
    }
    if (development) {
      return problems;
    }
    if (trimmed.length() < minLength) {
      problems.add(
          envVar + " is only " + trimmed.length() + " characters; at least " + minLength + ".");
    }
    if (KNOWN_INSECURE_SECRETS.contains(trimmed.toLowerCase(Locale.ROOT))) {
      problems.add(envVar + " is a known-public development value and cannot be used.");
    }
    return problems;
  }
}
