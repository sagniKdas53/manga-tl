# Run this as needed

## 🔒 Quality Gate Reference

> [!IMPORTANT]
> **Every phase must pass the full quality gate before manual testing begins.**
> Run these checks from the project root after completing each phase. All must exit 0.
---
> [!WARNING]
> **This PC is not very powerful. Do NOT run too many tasks in parallel during the quality gate, otherwise it will lock up and waste all the effort. Run checks sequentially.**

### Backend (Rust) — `cd backend-rust`

```bash
# 1. Format code (auto-fix)
cargo fmt

# 2. Verify formatting (CI parity check — must match what CI runs)
cargo fmt --check

# 3. Lint; CI runs this with -D warnings, so a warning here fails the build
cargo clippy --all-targets -- -D warnings

# 4. Full test suite against throwaway postgres/valkey/minio containers.
#    Never point cargo test at the live stack — see MIGRATION.md.
scripts/test-env.sh run

# 5. The API contract must not drift: exactly 71/71 operations
python3 ../scripts/diff_routes.py
```

**What each tool catches:**

| Tool | What it detects | Bound to |
| ------ | --------------- | ---------- |
| **rustfmt** | Formatting drift | `cargo fmt --check` |
| **Clippy** | Correctness traps, dead code, needless clones, style — warnings are errors in CI | `cargo clippy --all-targets -- -D warnings` |
| **cargo test** | Unit tests plus the integration suites under `backend-rust/tests/` | `scripts/test-env.sh run` |
| **diff_routes.py** | Route-table drift in BOTH directions — a route added to or lost from the frozen contract | `python3 scripts/diff_routes.py` |

### Frontend (React/TypeScript) — `cd frontend`

```bash
# 1. Lint (ESLint — catches unused vars, type errors, React issues)
npm run lint

# 2. Unit tests with HTML coverage (minimum 80% expected)
npm run test:coverage

# 3. Production build (catches TypeScript compilation errors, dead imports)
npm run build
```

### Worker (Python) — `cd worker`

```bash
# 1. Lint (catches bugs, unused imports, style issues)
ruff check .

# 2. Auto-fix safe lint issues + format
ruff check . --fix && ruff format .

# 3. Static type checking (catches type errors, None misuse, missing attrs)
pyright .

# 4. Unit tests with coverage (minimum 80% expected)
pytest tests/ --cov=. --cov-report=xml --cov-report=html
```
