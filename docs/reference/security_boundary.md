# Security Boundary — Public Routes and Authorization

This document records the access control boundary for the backend API (`backend-rust/src/routes/`). Public image routes are open deliberately for performance and caching.

## Access Boundaries

**Image display variants are public. State mutations, catalog queries, and raw original files require authentication.**

| Route | Access | Purpose |
| :--- | :--- | :--- |
| `/api/images/{id}/thumbnail` | **Public** | 512px WebP gallery thumbnail |
| `/api/images/{id}/reader` | **Public** | Downscaled WebP reading variant |
| `/api/images/{id}/thumbnail/rendered` | **Public** | 512px WebP rendered page thumbnail (`AUDIT-F26`) |
| `/actuator/health`, `/v3/api-docs` | **Public** | Container health checks and OpenAPI specification |
| `/api/auth/login`, `/register`, `/refresh` | **Public** | User authentication |
| `/api/images/{id}/file` | **Authenticated** (`AuthUser`) | Full-resolution original source image |
| `/api/series/**`, `/api/chapters/**`, `/api/pages/**` | **Authenticated** (`AuthUser`) | Catalog, metadata, and write operations |
| `/api/internal/**` | **Token Guarded** (`InternalAuth`) | Worker callbacks, fails closed if token is unset |

---

## Why Display Variants are Public

1. **Native `<img>` Decoding & Prioritization**: Native `<img>` tags cannot pass an `Authorization` header. Requiring authentication tokens in headers forces JavaScript to fetch images via `fetch()`, convert them to Object URLs (`URL.createObjectURL`), and assign them to image tags. This circumvents browser streaming decode, ruins HTTP caching, and increases reader latency.
2. **Cacheability**: Public, immutable image assets are cached by browsers and reverse proxies. Authenticated endpoints require `Cache-Control: private` or revalidation headers.
3. **Alignment with Manga Readers**: Following conventions like MangaDex, page view endpoints are unauthenticated CDN/proxy routes while user collections and state changes are authenticated.

---

## Scope of Exposure

- **UUID Addressing**: Endpoints require knowing the specific entity UUID. The catalog cannot be enumerated without authenticated access to `/api/series` or `/api/chapters/{id}/pages`.
- **Read-Only**: All public asset routes are HTTP `GET`.
- **Derived Formats Only**: Original full-resolution uploads (`/api/images/{id}/file`) require `AuthUser` authorization.
