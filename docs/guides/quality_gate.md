# Quality Gate Reference

Run these checks sequentially from the workspace root or respective subdirectories before committing. All checks must exit 0.

> [!WARNING]
> Do not execute checks across multiple services in parallel to avoid CPU throttling and test timeouts.

---

## 1. Backend (Rust) — `cd backend-rust`

```bash
# 1. Format code (auto-fix)
cargo fmt

# 2. Verify formatting
cargo fmt --check

# 3. Clippy lints (warnings treated as errors)
cargo clippy --all-targets -- -D warnings

# 4. Integration test suite against ephemeral test containers
scripts/test-env.sh run

# 5. Route contract validation
python3 ../scripts/diff_routes.py
```

| Tool | Detection Scope |
|---|---|
| **rustfmt** | Code formatting drift |
| **clippy** | Correctness, memory safety, style traps |
| **cargo test** | Unit tests and DB integration suites |
| **diff_routes.py** | API parity with golden OpenAPI specification |

---

## 2. Frontend (React / TypeScript) — `cd frontend`

```bash
# 1. Typecheck project references (AUDIT-T5)
npm run typecheck

# 2. Linting (ESLint)
npm run lint

# 3. Unit test suite
npm run test:coverage

# 4. Production bundle build
npm run build
```

| Tool | Detection Scope | Command |
|---|---|---|
| **tsc** | TypeScript compiler check across project references | `npm run typecheck` |
| **eslint** | Code style, React hook dependencies, syntax | `npm run lint` |
| **vitest** | Component and utility unit tests with coverage | `npm run test:coverage` |
| **vite build** | Production bundler validation | `npm run build` |

---

## 3. Worker (Python) — `cd worker`

All worker commands must execute inside the dedicated project root virtual environment (`../.venv`):

```bash
# 1. Auto-fix linter issues and format
../.venv/bin/python -m ruff check --fix . && ../.venv/bin/python -m ruff format .

# 2. Verify linter rules
../.venv/bin/python -m ruff check .

# 3. Verify format adherence
../.venv/bin/python -m ruff format --check .

# 4. Static type analysis
../.venv/bin/python -m pyright .

# 5. Unit test suite
../.venv/bin/python -m pytest -q
```

| Tool | Detection Scope | Command |
|---|---|---|
| **ruff** | Fast Python linting and code formatting | `../.venv/bin/python -m ruff check .` |
| **pyright** | Static typing and attribute verification | `../.venv/bin/python -m pyright .` |
| **pytest** | Test execution and assertion verification | `../.venv/bin/python -m pytest -q` |
