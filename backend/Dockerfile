# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Backend JAR
FROM maven:3.8.5-openjdk-17 AS backend-build
WORKDIR /app
COPY backend/pom.xml ./
COPY backend/src ./src
# Copy static frontend resources directly into Spring Boot classpath static folder
COPY --from=frontend-build /app/dist ./src/main/resources/static/
RUN mvn clean package -DskipTests -P!frontend

# Stage 3: Runtime JRE Image
FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=backend-build /app/target/library-0.0.1-SNAPSHOT.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]

