# Linting, Formatting & Type Checking (Frontend)

The frontend project uses **ESLint** for code style and linting, **Prettier** for code formatting, and **TypeScript** for static type analysis.

## Available Commands

Run these commands from the `frontend/` directory:

```bash
# Run ESLint to check for code quality and style issues
npm run lint

# Run ESLint and automatically fix fixable issues
npx eslint . --fix

# Run Prettier to format the codebase
npm run fmt

# Run TypeScript compiler type check without emitting files
npx tsc --noEmit
```

## Configuration Files

- **ESLint Config**: [eslint.config.js](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/eslint.config.js)
- **Prettier Config**: [.prettierrc](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/.prettierrc)
- **TypeScript Config**: [tsconfig.json](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/tsconfig.json)
