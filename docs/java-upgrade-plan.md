# Java Version Upgraded

## Plan

Here is the complete, step-by-step guide to achieving this hybrid deployment. By following this sequence, you will safely compile and test your application using Java 25 locally, and then deploy the resulting artifact into a high-performance Java 26 container.

### Phase 1: Upgrade the Host Machine (done)

Since your system's package manager provides outdated versions, you need to configure your local Ubuntu environment to compile Java 25 code using a compatible version of Maven.

1. **Install SDKMAN:** (done)
Download and initialize the environment manager:

```bash
curl -s "https://get.sdkman.io" | bash
source "$HOME/.sdkman/bin/sdkman-init.sh"

```

1. **Install Java 26:** (done)

```bash
sdk install java java 26.0.2-amzn

```

1. **Install the latest Maven:** (done)
This will install a version of Maven newer than the 3.9.16 requirement for Java 26.

```bash
sdk install maven

```

1. **Verify the installation:** (done)
Run `java -version` and `mvn -v` to ensure your host is now pointing to the newly installed Java 26 SDK and the updated Maven release.

---

### Phase 2: Compile and Test the Code

Before you can build the project, you must update the `pom.xml` so the build tools and compiler target the new Java 25 bytecode.

1. **Update the Spring Boot Parent:**
Change the `spring-boot-starter-parent` version from `3.2.5` to a version that supports Java 25 (e.g., `3.4.0`).

```xml
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.0</version>
    <relativePath/>
</parent>

```

1. **Update the Java Properties:**
Modify the properties block to declare the new target version, changing `<java.version>17</java.version>` to `25`.

```xml
<properties>
    <java.version>25</java.version>
    <jjwt.version>0.13.0</jjwt.version>
    <minio.version>9.0.3</minio.version>
</properties>

```

1. **Update the Compiler Plugin:**
In the `maven-compiler-plugin` configuration, change the `<release>17</release>` directive to `25`.

```xml
<plugin>
    <artifactId>maven-compiler-plugin</artifactId>
    <version>3.15.0</version>
    <configuration>
        <release>25</release>
        <annotationProcessorPaths>
            <path>
                <groupId>org.projectlombok</groupId>
                <artifactId>lombok</artifactId>
                <version>1.18.46</version>
            </path>
        </annotationProcessorPaths>
    </configuration>
</plugin>

```

1. **Update JaCoCo:**
Your current `jacoco-maven-plugin` is on version `0.8.15`. You should bump this to `0.8.16` to ensure it parses the Java 25/26 bytecode accurately when calculating your line coverage ratio.

2. **Run the Build and Tests:**
Execute a clean verification of the project.

```bash
mvn clean verify

```

This command will compile the Java 25 code, run your Surefire tests, and execute the bytecode analysis plugins (SpotBugs, PMD, and JaCoCo) bound to the `verify` phase. If this passes, your backend is fully verified on Java 25.

---

### Phase 3: Upgrade the Container

Now that you have successfully built a Java 25 artifact locally, you can update your Dockerfile to run that artifact inside a Java 26 environment to reap the garbage collection and startup benefits.

1. **Modify the Dockerfile:**
If you are using a multi-stage build, you can keep the builder on a Java 25/26 image, but the critical change is your **runtime base image**. Update it to a lightweight Java 26 JRE.

```dockerfile
# Stage 1: Build (if you are building inside Docker instead of copying the local JAR)
FROM maven:3-eclipse-temurin-26 AS backend-build
WORKDIR /app
# ... (copy pom/src and run mvn package)

# Stage 2: Runtime
FROM eclipse-temurin:26-jre-alpine
WORKDIR /app

# Copy the compiled Java 25 JAR from your host or previous stage
COPY target/library-0.0.1-SNAPSHOT.jar app.jar

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]

```

1. **Rebuild the Container:**
Run your Docker Compose build command to pull the new Java 26 image and deploy your `manga-library-backend`.

```bash
docker compose up -d --build

```
