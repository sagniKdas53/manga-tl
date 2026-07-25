# Run this as needed

## 🔒 Quality Gate Reference

> [!IMPORTANT]
> **Every phase must pass the full quality gate before manual testing begins.**
> Run these checks from the project root after completing each phase. All must exit 0.
---
> [!WARNING]
> **This PC is not very powerful. Do NOT run too many tasks in parallel during the quality gate, otherwise it will lock up and waste all the effort. Run checks sequentially.**

### Backend (Java) — `cd backend`

```bash
# 1. Format code (auto-fix)
mvn spotless:apply

# 2. Compile + unit tests + PMD + SpotBugs + JaCoCo coverage gate (≥80% expected)
mvn clean verify -DforkCount=1 -DreuseForks=true

# (Optional) Generate HTML coverage report explicitly at target/site/jacoco/index.html
mvn jacoco:report

# 3. Verify formatting (CI parity check — must match what CI runs)
mvn spotless:check
```

**What each tool catches:**

| Tool | What it detects | Bound to |
| ------ | --------------- | ---------- |
| **Spotless** | Formatting (Google Java Format), unused imports, trailing whitespace | Manual / pre-commit |
| **PMD 3.28.0** | God classes, complex methods, dead code, copy-paste, style violations | `mvn verify` |
| **SpotBugs 4.10.2** | Null pointer bugs, resource leaks, concurrency issues, bad practices (bytecode analysis) | `mvn verify` |
| **JaCoCo 0.8.15** | Line coverage gate — fails build if coverage < 80% | `mvn verify` |
| **Surefire** | Unit test failures | `mvn verify` |

### Frontend (React/TypeScript) — `cd frontend`

```bash
# 1. Lint (ESLint — catches unused vars, type errors, React issues)
npm run lint

# 2. Unit tests with HTML coverage (minimum 80% expected)
npm run test:coverage

# 3. Production build (catches TypeScript compilation errors, dead imports)
npm run build
```

### Worker (Python) — `cd unified-workers`

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
