# Testing Isolation Guide

This document explains how the test suites (Backend, Worker, and Frontend) run independently from the main application stack, ensuring that tests do not corrupt production data or interfere with real background jobs.

## The Problem: "The Stack" vs. "The Tests"

When you run `docker compose up`, you are spinning up a complete, interconnected environment (The Stack). This includes:
- **PostgreSQL Database** (listening on port 5432)
- **Redis Queue** (listening on port 6379)
- **MinIO Storage** (listening on port 9001)
- **Backend Application**
- **Unified Workers (Python)**
- **Frontend**

However, when you run tests locally (e.g., `mvn test` or `pytest`), these tests run **directly on your host operating system**—not inside the Docker containers.

By default, tests are configured to look for the database, Redis, and MinIO on `localhost`. If they connect to the same `localhost` ports exposed by Docker, they will accidentally interact with your real environment. This leads to:
- Test scripts dropping the real database tables (`ddl-auto: create-drop`).
- Test jobs being injected into the real Redis queue and processed by the real workers.
- The test suite hanging because it tries to connect to services (like MinIO on port 9000) that aren't properly exposed to the host machine.

## How We Isolated the Environments

To solve this, we explicitly configured the test environments to use "fake" or "isolated" connections instead of connecting to the real Docker stack.

### 1. Database Isolation (Backend)
Instead of connecting to the PostgreSQL container, the backend tests use an **in-memory H2 database**.
- We added the H2 dependency to `pom.xml`.
- In `backend/src/test/resources/application-test.yml`, the `datasource.url` is set to `jdbc:h2:mem:testdb`.
- **Result:** Tests create their own temporary database in RAM. When the test finishes, the memory is cleared. Your real PostgreSQL data remains untouched.

### 2. Redis Queue Isolation (Backend)
Redis has 16 logical databases (numbered `0` through `15`). 
- By default, the main application (and the real workers) use database `0`.
- We configured `application-test.yml` to set `spring.data.redis.database: 1`.
- **Result:** When the backend tests spawn jobs, they send them to database `1`. The real worker (listening on database `0`) never sees them, completely isolating the test queue from the production queue.

### 3. Worker Tests (Python)
The unified Python workers use `pytest`.
- Inside `unified-workers/tests/__init__.py`, the entire `redis.Redis` client is globally replaced with a `MagicMock`.
- **Result:** The Python tests never actually establish a network connection to Redis. They simulate the queue in memory, guaranteeing they will never accidentally pull jobs from your real database `0`.

### 4. Preventing Connection Hangs (MinIO & Workers)
In `docker-compose.yml`, MinIO only exposes port `9001` (console) to the host. The API port `9000` is strictly internal to the Docker network.
- When `mvn test` runs on the host OS, it tries to connect to `localhost:9000` to verify the MinIO bucket exists. Because port `9000` is not exposed, the connection attempt falls into a network blackhole, causing the entire test suite to hang indefinitely waiting for a TCP timeout.
- We fixed this by pointing `minio.endpoint` and `worker.urls` to `http://127.0.0.1:1` in `application-test.yml`.
- **Result:** Port `1` is guaranteed to be closed on your machine. This forces an immediate "Connection Refused" error, which the backend safely catches and ignores, allowing the tests to start instantly.

## Summary
Even when `docker compose up` is running in the background, your tests are now safely quarantined in their own parallel universe (In-memory H2, Redis DB 1, mocked Python services, and closed ports). You can run tests at any time without fear of disrupting the real stack!
