# Manga Library API Evaluation Report

This report outlines the current state of the backend API, identifies missing behaviors and documentation gaps, and proposes improvements to adhere to standard API conventions.

## 1. Documentation & Specification Gaps

> [!WARNING]
> The backend controllers completely lack explicit OpenAPI/Swagger annotations (`@Operation`, `@ApiResponse`, etc.). While `springdoc-openapi` can infer paths and methods, it cannot generate meaningful descriptions, summarize intent, or document custom error schemas without these annotations.

### Current Findings:
- **Missing Summaries and Descriptions:** Endpoints are exposed without clear explanations of what they do or what parameters they expect.
- **Undocumented Error Responses:** The generated spec defaults to showing only `200 OK` for most endpoints, omitting crucial error states (e.g., `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `500 Internal Server Error`).
- **Missing Request/Response Schemas:** Without annotations, some complex generic payload types or `Map<String, String>` bodies (such as in `AuthController.updateProfile`) are not strongly typed in the specification, making it harder for frontend clients to generate types.

### Recommendations:
- Annotate all controllers with `@Tag(name = "...", description = "...")`.
- Annotate all endpoints with `@Operation(summary = "...", description = "...")`.
- Document expected error conditions using `@ApiResponses` (e.g., documenting that `404` is returned if a `seriesId` doesn't exist).
- Replace weakly typed payloads (e.g., `Map<String, String>`) with explicit DTOs to improve schema generation.

---

## 2. API Design & Standards Improvements

> [!TIP]
> Following RESTful best practices ensures the API is predictable and easy to consume.

### Observations on Current Endpoints:
- **Action-based Endpoints:** Some endpoints use verbs in the URL path (e.g., `/api/jobs/{id}/retry`, `/api/jobs/{id}/resume`, `/api/ocr-regions/{id}/redo`). While this is common in RPC-style architectures, standard REST prefers modeling these as state transitions using `PATCH` or specific sub-resources.
- **HTTP Methods:**
  - `PUT` is used heavily for actions that seem to be partial updates (e.g., `/api/pages/{pageId}/number`). `PATCH` is semantically more correct for partial modifications, whereas `PUT` implies replacing the entire resource.
- **Inconsistent Pluralization:** Most resources are correctly pluralized (`/api/series`, `/api/chapters`), but ensuring this remains consistent across all new endpoints is critical.

### Recommendations:
- **Adopt `PATCH` for Partial Updates:** Transition endpoints like `/api/pages/{pageId}/number` to use `PATCH`.
- **Standardize Pagination & Filtering:** Ensure that list endpoints (`GET /api/series`, `GET /api/jobs`) clearly document their query parameters for pagination (`page`, `size`) and sorting (`sort`).
- **Use Standard HTTP Status Codes:** Ensure creation endpoints (`POST /api/series`) return `201 Created` with a `Location` header, rather than `200 OK`.

---

## 3. Missing Behaviors & Error Handling

> [!CAUTION]
> Inconsistent error handling can lead to poor client-side experiences and difficult debugging.

### Improvements Needed:
- **Global Exception Handling with Descriptive Payloads:** Returning empty `4XX` or `5XX` HTTP status codes is an anti-pattern. The `GlobalExceptionHandler` must return a standardized JSON structure across all endpoints. For example, instead of just returning a `404 Not Found` status when a `{chapterId}` or `{pageId}` is missing, it should return a descriptive JSON payload such as:
  ```json
  {
    "error": "Not Found",
    "message": "The chapter with ID 12345 does not exist.",
    "status": 404,
    "timestamp": "2026-07-24T00:00:00Z"
  }
  ```
  Adopting RFC 7807 (Problem Details for HTTP APIs) is highly recommended. Currently, some endpoints return plain text while others return partial JSON.
- **Validation Consistency:** Endpoints using `@Valid` (like `/api/auth/register`) should consistently return a structured map of field-level errors (e.g., `{"email": "Must be a valid email format"}`) inside the descriptive error payload when a `400 Bad Request` is triggered.
- **Rate Limiting & Security Documentation:** Security schemes (JWT Bearer Auth) are inferred, but rate-limiting headers (e.g., `X-RateLimit-Limit`) and behaviors are not explicitly documented in the API responses.

## Next Steps

1. **Adopt the Enriched Spec:** The generated `openapi.json` file in this workspace has been programmatically enriched with baseline descriptions and error codes to bridge the immediate gap.
2. **Backport to Code:** The long-term solution is to add `swagger-annotations` to the Spring Boot codebase (`@Operation`, `@Schema`, etc.) so the documentation lives alongside the code.
3. **Refactor Payloads:** Convert generic map parameters into strongly typed Java Records or DTOs to maximize auto-generation accuracy.
