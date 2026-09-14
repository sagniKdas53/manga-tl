# E01 preparation — reusable page-scene fitting primitives

## Status

**PREPARED, not started — 2026-09-14.** No production source, package manifest, import, test, renderer, asset, or scene contract changed in this preparation packet.

## Frozen inputs

- B01's strict new-format contract remains `contracts/page-scene-v1.schema.json`; E01 consumes no mutable layer data and must not add a legacy scene reader.
- M3's effective-`replace` authorization stays upstream of any future renderer. E01 only computes geometry; it must not alter policy, OCR, cleanup, or source pixels.
- Current heads after push: parent `cb5ccd7`, worker `8fc55f2`; corpus remains `27de7499f0c4c142763116bfcbcfd0afd9709cbf`.

## Existing implementation map

| Primitive | Current file | Browser dependency | Known callers |
| --- | --- | --- | --- |
| `fitTextInBox`, `clampLineCenter`, `FitResult` | `frontend/src/utils/fitText.ts` | Creates a canvas and uses `CanvasRenderingContext2D.measureText` | Reader SVG preview; PNG export; ZIP export |
| `ensureFontsLoaded` | `frontend/src/utils/fitText.ts` | `document.fonts.load` | PNG and ZIP export only |
| `textFitBox`, `DEFAULT_TEXT_BOX_INSET`, types | `frontend/src/utils/textFitBox.ts` | none | Reader and export paths |

GitNexus confirms `fitTextInBox` and `textFitBox` have two function-level callers: `Reader` and `doExport`. The latter contains both export callsites, so extraction changes three rendering sites total. Existing regression suites are `frontend/src/__tests__/utils/fitText.test.ts` and `textFitBox.test.ts`; the fit-box table is also intentionally mirrored in `worker/tests/test_render_extra.py`.

## Extraction boundary for E01

1. Create the source-only `packages/page-scene/` package. Its core must accept a text-measurement function/interface; it must not create a canvas, access `document`, load fonts, render DOM/SVG, read OCR, or accept editor handles.
2. Move `FitResult`, fit-box types/defaults, `textFitBox`, `clampLineCenter`, polygon/ellipse/rectangular wrapping, and font-size search into that core without semantic change. Preserve finite/inset guards, 1.2 line height, 0.95 ellipse/polygon width allowance, newline handling, and all three search tiers (`clean`, `contained`, `height`).
3. Keep `ensureFontsLoaded` and the canvas `measureText` adapter in `frontend/src/utils/` as a thin browser-only adapter. Migrate Reader's SVG/PNG/ZIP callers to one package implementation through that adapter; delete the duplicate core implementation rather than keeping a compatibility copy.
4. The repository has separate root and frontend `package-lock.json` files and no existing workspace declaration. Use a local `file:../packages/page-scene` dependency in `frontend/package.json` and update only the frontend lockfile if Vite/Vitest resolves the package as TypeScript source. Do not introduce a monorepo manager, a renderer service, Playwright, fonts, or a build pipeline in E01.

## Required E01 gate

```text
cd frontend
npm test -- src/__tests__/utils/fitText.test.ts src/__tests__/utils/textFitBox.test.ts
npm run typecheck
npm run build
```

The gate passes only if existing fitting cases retain their observable output and all Reader callers import one implementation. It makes no cleanup, typography-quality, browser-PNG, source-pixel, or performance claim; those belong to E02–E04/G4.

## First E01 action

Run GitNexus upstream impact on `fitTextInBox`, `textFitBox`, and `ensureFontsLoaded`, then create the package and adapters in one clean cutover. The current LSP service has no TypeScript server, so use GitNexus caller context plus the three known Reader callsites to verify the migration.

## Preserved worktree

Keep all M3 checkpoints/evidence, B01 contract fixtures, worker source-preserving policy, G0/A09 evidence, and corpus data unchanged.
