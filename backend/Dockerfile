# Stage 1: Build Frontend
#
# --platform=$BUILDPLATFORM pins this stage to the builder's own architecture. The output is a
# directory of JS/CSS — identical bytes whatever the target arch — so running it once natively
# rather than once per --platform is what makes the arm64 build of this image affordable.
# Without it, buildx re-runs `npm ci` and `vite build` under QEMU emulation for arm64, which is
# where almost all of a multi-arch build's time goes. Same reasoning on the maven stage below.
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend-build
WORKDIR /app

ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

COPY frontend/package*.json ./
# npm ci: reproducible, faster, uses lockfile exactly — preferred over npm install for CI/production
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Build Backend JAR
#
# Native to the builder for the same reason as stage 1: a Spring Boot fat JAR is bytecode plus
# the static resources copied in below, with nothing architecture-specific in it.
FROM --platform=$BUILDPLATFORM maven:3-eclipse-temurin-25 AS backend-build
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

# Stage 3: Build musl libwebp-imageio.so
#
# Deliberately NOT pinned to $BUILDPLATFORM: this stage compiles a native shared object that
# has to match the arch the image will actually run on, so it is the one stage that genuinely
# needs emulating per target. It is a single small C file, so the cost is minutes, not the
# tens of minutes an emulated npm/maven build would take.
# com.github.gotson:webp-imageio ships glibc builds only (native/Linux/<arch>), so on
# Alpine/musl the JNI lib fails to load with UnsatisfiedLinkError and thumbnails 404.
# Compile the wrapper (vendored from gotson/webp-imageio) against Alpine's musl libwebp.
FROM alpine:3.24 AS webp-native-build
RUN apk add --no-cache libwebp-dev musl-dev build-base
WORKDIR /src
COPY backend/src/main/c/ ./
RUN gcc -shared -fPIC -O2 \
      -I/src -I/src/jni -I/src/jni/unix \
      -I/usr/include/webp -I/usr/include \
      webp-imageio.c -lwebp -o libwebp-imageio.so

# Stage 4: Runtime JRE Image
FROM eclipse-temurin:25-jre-alpine

# libwebp.so.7 is a runtime dependency of the musl wrapper; install before dropping privileges
RUN apk add --no-cache libwebp

# Non-root user for security
RUN addgroup -S spring && adduser -S spring -G spring

WORKDIR /app
COPY --from=backend-build /app/target/library-0.0.1-SNAPSHOT.jar app.jar
# Place musl wrapper on java.library.path (NativeLoader falls back to it when the
# jar has no Linux-Alpine native resource)
COPY --from=webp-native-build /src/libwebp-imageio.so /usr/lib/libwebp-imageio.so

USER spring

EXPOSE 8080

# Healthcheck via Actuator endpoint (requires spring-boot-starter-actuator)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD wget --spider -q http://localhost:8080${CONTEXT_PATH:-/tlhub}/actuator/health || exit 1

ENTRYPOINT ["java", "--enable-native-access=ALL-UNNAMED", "-jar", "app.jar"]
