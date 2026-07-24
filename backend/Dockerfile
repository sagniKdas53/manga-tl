# Stage 1: Build Frontend
FROM node:26-alpine AS frontend-build
WORKDIR /app

ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

COPY frontend/package*.json ./
# npm ci: reproducible, faster, uses lockfile exactly — preferred over npm install for CI/production
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps

COPY frontend/ ./
RUN npm run build

# Stage 2: Build Backend JAR
FROM maven:3-eclipse-temurin-26 AS backend-build
WORKDIR /app

# Cache Maven dependencies separately so source changes don't re-download deps
COPY backend/pom.xml .
RUN --mount=type=cache,target=/root/.m2 \
    mvn dependency:go-offline -q

# Copy static frontend resources directly into Spring Boot classpath static folder
COPY --from=frontend-build /app/dist ./src/main/resources/static/
COPY backend/src ./src

RUN --mount=type=cache,target=/root/.m2 \
    mvn clean package -DskipTests -P!frontend

# Stage 3: Runtime JRE Image
FROM eclipse-temurin:26-jre-alpine

# Non-root user for security
RUN addgroup -S spring && adduser -S spring -G spring

WORKDIR /app
COPY --from=backend-build /app/target/library-0.0.1-SNAPSHOT.jar app.jar

USER spring

EXPOSE 8080

# Healthcheck via Actuator endpoint (requires spring-boot-starter-actuator)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD wget --spider -q http://localhost:8080${CONTEXT_PATH:-/tlhub}/actuator/health || exit 1

ENTRYPOINT ["java", "--enable-native-access=ALL-UNNAMED", "-jar", "app.jar"]
