# Frontend Commands

Commands for development, testing, and linting in `frontend/`.

## Development & Build

```bash
# Start local development server
npm run dev

# Build production bundle (runs typecheck + vite build)
npm run build

# Preview production build locally
npm run preview

# Generate TypeScript API definitions from OpenAPI spec
npm run generate-api
```

## Linting & Typechecking

```bash
# Typecheck composite project references (AUDIT-T5)
npm run typecheck

# Run ESLint across code and tests
npm run lint

# Auto-fix lint issues
npx eslint . --fix

# Format code with Prettier
npm run format

# Verify formatting without modifying files
npm run format:check
```

## Testing

```bash
# Run unit test suite
npm run test

# Run unit tests with code coverage report
npm run test:coverage
```
