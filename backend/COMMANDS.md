# Backend Commands Guide

This document lists the common commands used for development, testing, formatting, and building the Spring Boot backend project.

The backend uses **Maven** for dependency management and building, **Spotless** for code formatting, and **JaCoCo** for test coverage.

## Development & Build

Run these commands from the `backend/` directory:

```bash
# Run the Spring Boot application locally (requires Postgres running)
mvn spring-boot:run

# Compile the source code without running tests
mvn clean compile

# Build the final JAR package (skips tests if desired using -DskipTests)
mvn clean package
```

## Linting & Formatting

```bash
# Auto-format all code using Spotless (run before committing)
mvn spotless:apply

# Verify that formatting is clean (will fail if files are unformatted)
mvn spotless:check
```

## Testing & Quality Gate

```bash
# Run unit tests only
mvn test

# Run full quality gate (compiles, runs tests, generates JaCoCo coverage report, and runs PMD/SpotBugs if configured)
mvn clean verify
```

## Reports

- **JaCoCo Coverage Report**: Generated at `backend/target/site/jacoco/index.html` after running tests or verify.
