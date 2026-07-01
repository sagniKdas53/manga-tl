# Frontend Commands Guide

This document lists the common commands used for development, testing, and linting in the frontend project.

The frontend uses **Vite** for the build tool, **React** for the UI, **ESLint** & **Prettier** for code style, **Vitest** for testing, and **TypeScript** for static type analysis.

## Development & Build

Run these commands from the `frontend/` directory:

```bash
# Start the local development server (with hot-reloading)
npm run dev

# Build the production bundle
npm run build

# Preview the production build locally
npm run preview
```

## Linting & Formatting

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

## Testing

```bash
# Run all unit tests
npm run test

# Run tests and generate code coverage report (including HTML report)
npm run test:coverage
```

## Configuration Files

- **ESLint Config**: `eslint.config.js`
- **Prettier Config**: `.prettierrc`
- **TypeScript Config**: `tsconfig.json`
- **Vite/Vitest Config**: `vite.config.ts`
