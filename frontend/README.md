# Manga Library — Frontend

Web application for Manga Library, providing the interactive manga reader, canvas-based scanlation layer editor, pipeline queue monitor, and series management.

## Tech Stack

- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite
- **Component Library**: Material UI v9 (`@mui/material`)
- **API Client**: `openapi-fetch` typed via `src/api/schema.d.ts`
- **Testing**: Vitest with `@testing-library/react`
- **Linting & Formatting**: ESLint (flat config) + Prettier

## Architecture & Key Components

1. **Reader & Canvas Editor** (`src/components/Reader.tsx`):
   - SVG/HTML5 canvas rendering of manga pages, masks, OCR bounding polygons, and translated text.
   - Interactive editing: text-box dragging, rotation, vertex reshaping, font sizing, and visibility toggling.
   - Layer inspection and hierarchy panel (`ReaderRightSidebar.tsx`).
2. **Real-time Pipeline Synchronization**:
   - `useSSE` (`src/utils/useSSE.ts`): Server-Sent Events listener receiving `job_update` events from the backend.
   - `PipelineRefreshWatcher` (`src/components/PipelineRefreshWatcher.tsx`): Coordinates automatic background refetching of series, chapter, and page metadata across completed jobs with a 4s debounce and 30s cadence floor (`AUDIT-F27`).
3. **Queue Manager** (`src/components/QueueManager.tsx`):
   - Real-time display and prioritization of active, pending, and completed pipeline jobs.
4. **Settings & Providers** (`src/components/SettingsModal.tsx`):
   - Configuration modal for OCR engines, LLM translation providers, and QA modes.

## Development Workflow

### Requirements
- Node.js 20.19+ or 22.12+ (Vite 8 engine requirement)
- Running backend instance (default `http://localhost:8080`)

### Running Locally

```bash
# Install dependencies
npm install

# Start development server on port 5173
npm run dev

# Start development server exposed on LAN
npm run host
```

### OpenAPI Contract Synchronization

When backend DTOs or endpoints change, regenerate TypeScript types from the running backend:

```bash
npm run generate-api
```

### Verification & Gates

```bash
# Prettier formatting (CI runs this first)
npm run format:check

# Typecheck project references (tsconfig.app.json + tsconfig.node.json)
npm run typecheck

# Lint codebase
npm run lint

# Run unit tests
npm run test

# Build production bundle
npm run build
```
