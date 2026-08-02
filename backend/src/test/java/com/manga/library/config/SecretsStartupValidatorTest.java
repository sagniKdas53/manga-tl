package com.manga.library.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class SecretsStartupValidatorTest {

  private static final String GOOD_JWT = "a-perfectly-adequate-production-jwt-secret-value";
  private static final String GOOD_TOKEN = "a-good-internal-token";

  /** The value {@code application.yml} used to default to. It is public on GitHub. */
  private static final String TUTORIAL_JWT_KEY =
      "5367566B59703373367639792F423F4528482B4D6251655468576D5A71347437";

  @Test
  void acceptsStrongSecretsInProduction() {
    SecretsStartupValidator.validate(false, GOOD_JWT, GOOD_TOKEN);
  }

  @Test
  void rejectsUnsetJwtSecret() {
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> SecretsStartupValidator.validate(false, "", GOOD_TOKEN));
    assertTrue(ex.getMessage().contains("JWT_SECRET"), ex.getMessage());
  }

  @Test
  void rejectsNullSecret() {
    assertThrows(
        IllegalStateException.class, () -> SecretsStartupValidator.validate(false, null, GOOD_TOKEN));
  }

  @Test
  void rejectsBlankSecretEvenInDevelopment() {
    // A development profile relaxes the strength rules, never the requirement to have a value:
    // JwtUtils would otherwise build a signing key from an empty byte array.
    assertThrows(
        IllegalStateException.class, () -> SecretsStartupValidator.validate(true, "   ", GOOD_TOKEN));
  }

  @Test
  void rejectsUnsetInternalApiToken() {
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> SecretsStartupValidator.validate(false, GOOD_JWT, ""));
    assertTrue(ex.getMessage().contains("INTERNAL_API_TOKEN"), ex.getMessage());
  }

  @Test
  void reportsEverySecretAtOnce() {
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class, () -> SecretsStartupValidator.validate(false, "", ""));
    assertTrue(ex.getMessage().contains("JWT_SECRET"), ex.getMessage());
    assertTrue(ex.getMessage().contains("INTERNAL_API_TOKEN"), ex.getMessage());
  }

  @Test
  void rejectsThePublishedTutorialJwtKey() {
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> SecretsStartupValidator.validate(false, TUTORIAL_JWT_KEY, GOOD_TOKEN));
    assertTrue(ex.getMessage().contains("known-public"), ex.getMessage());
  }

  @Test
  void rejectsTheOldInternalTokenDefault() {
    assertThrows(
        IllegalStateException.class,
        () ->
            SecretsStartupValidator.validate(false, GOOD_JWT, "manga-library-internal-token-12345"));
  }

  @Test
  void rejectsShortJwtSecret() {
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> SecretsStartupValidator.validate(false, "too-short", GOOD_TOKEN));
    assertTrue(ex.getMessage().contains("characters"), ex.getMessage());
  }

  @Test
  void toleratesDevelopmentPlaceholdersUnderADevelopmentProfile() {
    SecretsStartupValidator.validate(true, TUTORIAL_JWT_KEY, "manga-library-internal-token-12345");
  }

  @Test
  void recognisesDevelopmentProfiles() {
    assertTrue(SecretsStartupValidator.isDevelopment(new String[] {"local"}));
    assertTrue(SecretsStartupValidator.isDevelopment(new String[] {"test"}));
    assertTrue(SecretsStartupValidator.isDevelopment(new String[] {"integration"}));
    assertTrue(SecretsStartupValidator.isDevelopment(new String[] {"prod", "local"}));
    assertFalse(SecretsStartupValidator.isDevelopment(new String[] {}));
    assertFalse(SecretsStartupValidator.isDevelopment(new String[] {"prod"}));
  }

  @Test
  void constructorValidatesAgainstTheActiveEnvironment() {
    MockEnvironment production = new MockEnvironment();
    assertThrows(
        IllegalStateException.class,
        () -> new SecretsStartupValidator(production, "", ""),
        "an unconfigured production environment must not construct");

    MockEnvironment development = new MockEnvironment();
    development.setActiveProfiles("local");
    SecretsStartupValidator validator =
        new SecretsStartupValidator(development, GOOD_JWT, GOOD_TOKEN);
    assertEquals(SecretsStartupValidator.class, validator.getClass());
  }
}
