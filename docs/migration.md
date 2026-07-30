# Migrate Backend to a usable language form that bullshit that is Java

## Migration strategy — Java/Spring → Python/FastAPI

### Why

Java + Spring Boot + Hibernate caused every single issue above:

| Issue | Java root cause |
| ------- | ---------------- |
| Missing PKs | Hibernate `ddl-auto` silently skipped DDL |
| Proxy serialization 500 | ByteBuddy interceptor + Jackson + open-in-view death triangle |
| Page not found → 500 | `IllegalArgumentException` not mapped, Java exception hierarchy chaos |
| Empty translation layer | No Python-side issue, but Java backend accepted broken callback silently |
| Useless tests | Mock-everything architecture is the standard Java testing pattern |
| Docker image 300MB | JRE alone is heavier than entire Python app |

None of these problems exist in Python/FastAPI because:

- SQLAlchemy has no bytecode proxies
- Pydantic serializes explicit fields only — no `hibernateLazyInitializer` leaks
- Alembic migrations are explicit SQL — nothing is "auto" and nothing silences errors
- FastAPI's `HTTPException` maps directly to status codes with messages
- pytest + Testcontainers is the standard pattern for real integration tests

### Migration Strategy (DO NOT START — plan only)

#### Prerequisites before starting

1. All critical bugs above fixed in the current Java backend (so the system works during migration)
2. API contract documented (all endpoints, request/response shapes)
3. Worker API stays 100% compatible (same URLs, same JSON shapes)

#### Phases (estimated 2 weeks total)

| Phase | Scope | Days |
| ------- | ------- | ------ |
| 1. Models & DB | SQLAlchemy models, Alembic migration, DB config | 2-3 |
| 2. Auth | JWT middleware, internal token filter, user endpoints | 1-2 |
| 3. Core API | Pages, images, chapters, series endpoints | 3-4 |
| 4. Pipeline API | Job callback endpoints (panel, ocr, layout, tl, render, qa) | 1-2 |
| 5. Layers & editing | Layer CRUD, layer elements, OCR region editing | 1-2 |
| 6. Wire up | Dockerfile, docker-compose, switch backend service | 1 |
| 7. Cleanup | Remove Java backend, update docs | 0.5 |

#### Project structure (FastAPI)

```txt
backend-py/
├── app/
│   ├── main.py              # FastAPI app, lifespan, middleware
│   ├── config.py             # Settings from env vars
│   ├── database.py           # SQLAlchemy async engine + session
│   ├── models/               # SQLAlchemy ORM models
│   │   ├── user.py
│   │   ├── series.py
│   │   ├── chapter.py
│   │   ├── image.py
│   │   ├── page.py
│   │   ├── panel.py
│   │   ├── ocr_region.py
│   │   ├── layer.py
│   │   ├── layer_element.py
│   │   ├── conversation.py
│   │   └── job.py
│   ├── schemas/              # Pydantic request/response models
│   │   ├── auth.py
│   │   ├── page.py
│   │   ├── chapter.py
│   │   └── ...
│   ├── routers/              # API route handlers
│   │   ├── auth.py
│   │   ├── pages.py
│   │   ├── images.py
│   │   ├── chapters.py
│   │   ├── series.py
│   │   ├── layers.py
│   │   ├── jobs.py
│   │   └── internal.py       # Worker callback endpoints
│   ├── services/             # Business logic
│   │   ├── auth.py
│   │   ├── page.py
│   │   ├── minio.py
│   │   └── worker.py
│   └── middleware/
│       ├── auth.py           # JWT verification
│       └── internal.py       # X-Internal-Token check
├── alembic/                  # DB migrations
│   └── versions/
├── tests/
├── requirements.txt
├── Dockerfile
└── alembic.ini
```

#### Key decisions to make before starting

1. **Async vs sync**: FastAPI supports async. SQLAlchemy 2.0 has async support. Worth it? (Yes — free performance, no thread pool exhaustion)
2. **MinIO client**: `boto3` (S3-compatible) or `minio-py`? (boto3 is more standard)
3. **Redis**: `redis-py` with `hiredis` for performance
4. **Migrations at startup**: Run `alembic upgrade head` in Docker entrypoint before starting uvicorn
5. **API path**: Keep `/tlhub` context path for backward compatibility with frontend and worker

#### What NOT to migrate

- Worker service — stays as-is (already Python)
- Frontend — stays as-is (REST consumer)
- PostgreSQL, Redis, MinIO — no changes
- Docker Compose networking — same service names
