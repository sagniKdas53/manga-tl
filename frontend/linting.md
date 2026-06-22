# Linting & Type Checking (Frontend)

The frontend project uses **ESLint** for code style and linting, and **TypeScript** for static type analysis.

## Available Commands

Run these commands from the `frontend/` directory:

```bash
# Run ESLint to check for code quality and style issues
npm run lint

# Run ESLint and automatically fix fixable issues
npx eslint . --fix

# Run TypeScript compiler type check without emitting files
npx tsc --noEmit
```

## Configuration Files
- **ESLint Config**: [eslint.config.js](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/eslint.config.js)
- **TypeScript Config**: [tsconfig.json](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/tsconfig.json)

