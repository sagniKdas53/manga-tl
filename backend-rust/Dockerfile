# syntax=docker/dockerfile:1
#
# Multi-arch Rust replacement for the Java image (backend/Dockerfile).
#
# Same three ideas as the Java build:
#   1. The frontend stage runs natively on $BUILDPLATFORM — JS/CSS bytes are identical for
#      every target arch, and emulated npm is where multi-arch builds lose hours.
#   2. The backend artifact is also built on $BUILDPLATFORM. A JAR needs no toolchain; a Rust
#      binary needs one, so the arm64 build cross-compiles with gcc-aarch64-linux-gnu instead
#      of letting buildx emulate the whole cargo tree under QEMU.
#   3. Only stages that genuinely produce target-specific output pay per-platform cost.
#
# Differences from the Java build:
#   * NO JNI/libwebp-native stage — vendored libwebp compiles under cargo like any crate.
#   * cargo-chef splits dependency compilation from source compilation, so touching one .rs
#     file rebuilds in minutes instead of recompiling every crate.
#   * Runtime is debian-slim (glibc, matching the gnu target), not alpine/musl — swapping to
#     musl would mean static-linking sqlx+reqwest stacks against a different libc than CI.

# ---------------------------------------------------------------------------
# Stage 1: Frontend bundle (architecture-independent)
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend-build
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
WORKDIR /app

COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2/3/4: cargo-chef plan -> cook dependencies -> build binary
# All on $BUILDPLATFORM; arm64 is a cross-compile, not an emulation.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS chef
# cargo-chef templates Cargo workspaces into "recipe" layers so dependency builds cache
# independently of application source.
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY backend-rust/ ./backend-rust/
WORKDIR /app/backend-rust
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
ARG TARGETARCH
WORKDIR /app/backend-rust
# rust-toolchain.toml selects the toolchain for every rustup/cargo call under this directory,
# and it MUST land before `rustup target add`.
#
# The image's default toolchain is named `1.98.0-x86_64-unknown-linux-gnu`; the file asks for
# `channel = "stable"`, which rustup resolves to a SEPARATE install named
# `stable-x86_64-unknown-linux-gnu` — same rustc, different directory. Add the target with no
# toolchain file present and aarch64's std goes into `1.98.0`, while the build later runs
# under `stable` and dies with: error[E0463]: can't find crate for `std`.
#
# amd64 could never catch this: it adds no target at all, so it does not care which of the two
# toolchains is active. That is exactly how this shipped unnoticed — arm64 was in the
# `platforms:` list but had never actually been built.
COPY backend-rust/rust-toolchain.toml ./
# Cross toolchain for arm64: rustc emits the object files, the GNU linker links them.
# amd64 builds run fully native and need nothing extra.
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        rustup target add aarch64-unknown-linux-gnu \
        && apt-get update \
        && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
        && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=planner /app/backend-rust/recipe.json recipe.json
# Cook dependencies only — this layer stays cached until Cargo.toml/lock change.
#
# The cache id MUST be scoped by $TARGETARCH. This stage is `FROM --platform=$BUILDPLATFORM` but
# branches on TARGETARCH, so buildx instantiates it once per target platform and runs both legs
# concurrently. An unscoped `type=cache` mount is shared by default, which puts two cargo processes
# into the same registry directory unpacking the same crates — and cargo's unpack is not
# concurrency-safe. It fails the moment one leg finds the other's half-written marker:
#   failed to open .../tracing-core-0.1.36/.cargo-ok  Caused by: File exists (os error 17)
# That took out every `main` build from the rust-backend merge onward. `sharing=locked` on top
# serialises any two builds that do land on the same id.
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=cargo-registry-${TARGETARCH},sharing=locked \
    if [ "$TARGETARCH" = "arm64" ]; then \
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
        && cargo chef cook --release --target aarch64-unknown-linux-gnu --recipe-path recipe.json; \
    else \
        cargo chef cook --release --recipe-path recipe.json; \
    fi

COPY backend-rust/ ./
# rust-embed bakes this at compile time; the frontend stage must run first.
COPY --from=frontend-build /app/dist ../frontend/dist
# Static healthcheck probe (src/main/c/healthcheck.c) — see its header comment for why
# it exists instead of curl-in-runtime.
# Same arch-scoped cache id as the cook step above, for the same reason.
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=cargo-registry-${TARGETARCH},sharing=locked \
    if [ "$TARGETARCH" = "arm64" ]; then \
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
        && aarch64-linux-gnu-gcc -static -O2 -s src/main/c/healthcheck.c -o /usr/local/bin/healthcheck \
        && cargo build --release --target aarch64-unknown-linux-gnu \
        && cp target/aarch64-unknown-linux-gnu/release/manga-backend /usr/local/bin/manga-backend; \
    else \
        gcc -static -O2 -s src/main/c/healthcheck.c -o /usr/local/bin/healthcheck \
        && cargo build --release \
        && cp target/release/manga-backend /usr/local/bin/manga-backend; \
    fi

# ---------------------------------------------------------------------------
# Stage 5: Runtime
#
# Deliberately package-free: no apt-get here, because apt under buildx QEMU emulation
# is what kills arm64 builds. The static healthcheck probe replaces curl/wget, and the
# CA bundle is copied from the builder for rustls outbound TLS.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /usr/local/bin/manga-backend /usr/local/bin/manga-backend
COPY --from=builder /usr/local/bin/healthcheck /usr/local/bin/healthcheck

RUN groupadd --system spring && useradd --system --gid spring --home-dir /app spring
WORKDIR /app

USER spring
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["/usr/local/bin/healthcheck"]

ENTRYPOINT ["manga-backend"]
