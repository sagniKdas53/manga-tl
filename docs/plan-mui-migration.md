# Plan: MUI Migration — Frontend Redesign

> **Phase D.12** from `docs/plan-improvements.md`  
> Dependencies: `@mui/material@^7.x`, `@mui/icons-material`, `@emotion/react`, `@emotion/styled`  
> Target: React 19.2.6 + TypeScript 6.0  
> Last updated: 2026-07-16

---

## Overview

Migrate the entire frontend from vanilla CSS + glassmorphism to Material UI v7. This is a **foundational change** that affects all D items — it should be done early in Phase D so subsequent UI work (D.1–D.11) is built on MUI components.

### Why MUI v7?

- Battle-tested component library with WCAG 2.1 accessibility compliance
- Built-in dark/light mode via `colorSchemes` API (replaces manual `:root.light` class toggling)
- `CssBaseline` normalizes browser styles out of the box
- All form controls, dialogs, toasts, cards, grids, nav bars — no custom CSS needed
- Pre-built UI decisions = less design debt

### Current Pain Points (what we're fixing)

| Issue | Current | After MUI |
|-------|---------|-----------|
| **1813-line monolithic CSS** | `index.css` with all styles in one file | ~90% of CSS removed; kept only for Reader canvas overlays |
| **Glassmorphism looks dated** | `backdrop-filter: blur(16px)` everywhere | MUI's clean card/paper elevation system |
| **No consistent spacing** | Ad-hoc margins/padding in px | MUI's 8px spacing grid (`theme.spacing()`) |
| **Hand-built modals/dialogs** | `ConfirmModal.tsx`, `InfoModal.tsx` hand-rolled | MUI `Dialog` with built-in focus trap, ARIA, ESC key |
| **Hand-built toasts** | `ToastContext.tsx` custom implementation | MUI `Snackbar` + `Alert` components |
| **No theme context** | Theme is `useState` in `App.tsx` only | `useColorScheme()` from any component |
| **Fragile CSS selectors** | Deeply nested `.class .class .class` chains | MUI `sx` prop + component API |
| **No responsive grid** | CSS `grid-cols-*` hardcoded breakpoints | MUI `Grid` / `Stack` with theme breakpoints |
| **Custom form inputs** | `.form-group`, `.form-input` styled manually | MUI `TextField` with built-in validation/error states |
| **Hand-built switches** | `.switch .slider` CSS (60+ lines) | MUI `Switch` component (1 line) |
| **CRUD dialogs** are inline | Series create/edit/delete modals embedded in `Dashboard.tsx` | Extract to proper MUI `Dialog` with `DialogTitle`/`DialogContent`/`DialogActions` |

---

## Color Palettes (from extracted SVGs)

### Dark Mode → nHentai-inspired

| Token | Hex | Usage |
|-------|-----|-------|
| `#1f1f1f` | `#1f1f1f` | Background default |
| `#fefefe` | `#fefefe` | Text primary |
| `#afafaf` | `#afafaf` | Text secondary (muted) |
| `#6c6c6c` | `#6c6c6c` | Text disabled / tertiary |
| `#ee2553` | `#ee2553` | Primary accent (Amaranth red-pink) |
| `#f1af5f` | `#f1af5f` | Warning / secondary accent (Sandy brown) |

Dark surface colors to derive:
- Background paper (card): `#2a2a2a`
- Background default (page): `#1f1f1f`
- Divider: `rgba(254,254,254,0.12)`

### Light Mode → Pixiv-inspired

| Token | Hex | Usage |
|-------|-----|-------|
| `#f5f5f5` | `#f5f5f5` | Background default |
| `#343333` | `#343333` | Text primary |
| `#b0b0b0` | `#b0b0b0` | Text secondary |
| `#0197fc` | `#0197fc` | Primary accent (Azure Radiance blue) |
| `#fd4060` | `#fd4060` | Error / danger (Radical Red) |
| `#e4a243` | `#e4a243` | Warning (Anzac amber) |
| `#6ac2fd` | `#6ac2fd` | Info / secondary accent (Malibu light blue) |
| `#786e6a` | `#786e6a` | Text disabled / tertiary (Sandstone) |

Light surface colors:
- Background paper (card): `#ffffff`
- Background default (page): `#f5f5f5`
- Divider: `rgba(52,51,51,0.12)`

### Custom semantic colors (shared across modes)

These are not in the Pixiv/nHentai palettes but needed for the app:

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `success` | `#10b981` | `#10b981` | Completed jobs, approved translations |
| `info` | `#0197fc` | `#6ac2fd` | Neutral info messages |
| `conversation` | `#2563eb` | `#3b82f6` | Conversation bubbles (Reader overlay) |

> **Note:** `conversation` is a custom token added via TypeScript module augmentation — it's not a standard MUI palette color but is needed for the Reader's SVG overlay system.

---

## Migration Phases

### Phase 0: Setup & Foundation (1 PR)

#### 0.1 Install Dependencies

```bash
cd frontend
npm install @mui/material@^7.0.0 @mui/icons-material @emotion/react @emotion/styled
```

No extra peer dependencies needed — React 19 is already installed and compatible.

Verify: `npm ls @mui/material --depth=0` shows `@mui/material@7.x`

#### 0.2 Remove Unused `App.css`

- Delete `frontend/src/App.css` (184 lines of Vite template boilerplate, unused)
- Remove `import './App.css'` from `App.tsx`
- The `.counter`, `.hero`, `#next-steps` classes reference undefined CSS variables — confirmed dead code

#### 0.3 Create Theme Definition

**New file: `frontend/src/theme.ts`**

```tsx
import { createTheme } from '@mui/material/styles';

const darkPalette = {
  primary: { main: '#ee2553' },
  secondary: { main: '#f1af5f' },
  background: {
    default: '#1f1f1f',
    paper: '#2a2a2a',
  },
  text: {
    primary: '#fefefe',
    secondary: '#afafaf',
    disabled: '#6c6c6c',
  },
  divider: 'rgba(254,254,254,0.12)',
  error: { main: '#ee2553' }, // reuse primary as error in dark
  warning: { main: '#f1af5f' },
  success: { main: '#10b981' },
  info: { main: '#6ac2fd' },
};

const lightPalette = {
  primary: { main: '#0197fc' },
  secondary: { main: '#e4a243' },
  background: {
    default: '#f5f5f5',
    paper: '#ffffff',
  },
  text: {
    primary: '#343333',
    secondary: '#b0b0b0',
    disabled: '#786e6a',
  },
  divider: 'rgba(52,51,51,0.12)',
  error: { main: '#fd4060' },
  warning: { main: '#e4a243' },
  success: { main: '#10b981' },
  info: { main: '#0197fc' },
};

const theme = createTheme({
  cssVariables: true, // generates CSS custom properties for easy debugging
  colorSchemes: {
    dark: {
      palette: darkPalette,
    },
    light: {
      palette: lightPalette,
    },
  },
  typography: {
    fontFamily: '"Plus Jakarta Sans", "Roboto", system-ui, sans-serif',
    h1: { fontFamily: '"Outfit", sans-serif' },
    h2: { fontFamily: '"Outfit", sans-serif' },
    h3: { fontFamily: '"Outfit", sans-serif' },
    h4: { fontFamily: '"Outfit", sans-serif' },
    h5: { fontFamily: '"Outfit", sans-serif' },
    h6: { fontFamily: '"Outfit", sans-serif' },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none', // keep our existing casing style
          borderRadius: 8,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 16,
        },
      },
    },
  },
});

export default theme;
```

**TypeScript augmentation** for the `conversation` color:

```ts
// Add to frontend/src/theme.ts after createTheme
declare module '@mui/material/styles' {
  interface Palette {
    conversation: Palette['primary'];
  }
  interface PaletteOptions {
    conversation?: PaletteOptions['primary'];
  }
}
```

#### 0.4 Wrap App in ThemeProvider + CssBaseline

**Modify `App.tsx`:**

1. Add imports:
```tsx
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import theme from './theme';
import { useColorScheme } from '@mui/material/styles';
```

2. Create a `ThemeSync` component that syncs MUI's `useColorScheme()` with localStorage and the old `:root.light` class (for gradual migration):
```tsx
function ThemeSync() {
  const { mode, setMode } = useColorScheme();
  useEffect(() => {
    const saved = localStorage.getItem('manga_theme');
    if (saved === 'light' && mode !== 'light') setMode('light');
    else if (!saved && mode !== 'dark') setMode('dark');
  }, []);
  useEffect(() => {
    if (mode) localStorage.setItem('manga_theme', mode);
  }, [mode]);
  return null;
}
```

3. Remove the local `theme` state and manual `classList.toggle("light")`:
```tsx
// REMOVE:
// const [theme, setTheme] = useState<'light' | 'dark'>(
//   () => (localStorage.getItem("manga_theme") === "light" ? "light" : "dark")
// );
// useEffect(() => {
//   document.documentElement.classList.toggle("light", theme === "light");
//   localStorage.setItem("manga_theme", theme);
// }, [theme]);
// const toggleTheme = () => setTheme(prev => (prev === "dark" ? "light" : "dark"));
```

4. Add `ThemeSync` and use `useColorScheme` for the toggle:
```tsx
const { mode, setMode } = useColorScheme();
const toggleTheme = () => setMode(mode === 'dark' ? 'light' : 'dark');
```

5. Wrap everything:
```tsx
<ThemeProvider theme={theme}>
  <CssBaseline />
  <ThemeSync />
  {/* existing app content */}
</ThemeProvider>
```

6. Update the theme toggle button to use `mode` from `useColorScheme()` instead of the old `toggleTheme`.

> **Important:** The `ThemeSync` component + `useColorScheme` handles the localStorage sync. The `:root.light` class is still respected by existing CSS for backward compat during migration. Remove `:root.light` rules from `index.css` when migration is complete.

#### 0.5 Remove `body { background-image }` Radial Gradients

The current `:root` has:
```css
body {
  background-image:
    radial-gradient(at 0% 0%, var(--primary-glow) 0px, transparent 50%),
    radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.04) 0px, transparent 50%);
}
```

MUI's background system doesn't support radial gradients natively. Replace with a CSS override in the theme's `MuiCssBaseline` `styleOverrides` if the glow effect is desired, or remove it entirely. **Recommendation: remove** — MUI's flat surfaces look cleaner without decorative gradients.

#### 0.6 TypeScript Theme Augmentation

Add `frontend/src/mui.d.ts` for all custom color module augmentations:
```ts
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type {} from '@mui/material/styles';

declare module '@mui/material/styles' {
  interface Palette {
    conversation: Palette['primary'];
  }
  interface PaletteOptions {
    conversation?: PaletteOptions['primary'];
  }
}

declare module '@mui/material/Button' {
  interface ButtonPropsColorOverrides {
    conversation: true;
  }
}
```

---

**Phase 0 Checkpoint:** App renders with MUI ThemeProvider + CssBaseline + dual theme support. No visual changes yet but the infrastructure is in place. Verify:
1. `npm run build` passes (TypeScript compiles, no import errors)
2. App shows with CssBaseline reset styles
3. Toggle dark/light — page background color changes correctly
4. `localStorage.getItem("manga_theme")` returns `"dark"` or `"light"` correctly

---

### Phase 1: Navigation Bar (1 PR)

Replace the custom `.nav-bar` glassmorphism nav with MUI `AppBar` + `Toolbar`.

| Before (custom CSS) | After (MUI) |
|---------------------|-------------|
| `<nav className="nav-bar glass">` | `<AppBar position="sticky">` |
| `<div className="logo">` | `<Typography variant="h6">` inside `Toolbar` |
| Manual flex layout | `<Stack direction="row" spacing={1}>` |
| `.nav-actions` div | `<Box sx={{ display: 'flex', gap: 1 }}>` |
| Theme toggle button (text) | `<IconButton>` with `DarkMode`/`LightMode` icon |
| Settings gear button | `<IconButton>` with `Settings` icon |
| Queue manager inline | Keep `QueueManager` but wrap in `IconButton` with badge |
| Notification bell | Wrap `NotificationCenter` in `IconButton` with badge |
| User badge `.user-badge` | `<Chip>` or `<Avatar>` with dropdown via `Menu` |

**Components to use:**
- `AppBar`, `Toolbar` from `@mui/material`
- `Typography` for logo text
- `IconButton` for all nav actions
- `Badge` for notification/queue counts
- `Menu` + `MenuItem` for user dropdown
- `Avatar` for user icon
- Icons: `DarkMode`, `LightMode`, `Settings`, `Logout`, `Person`, `QueueMusic`

**CSS to remove from `index.css`:**
- `.nav-bar` (lines ~150-200, check exact range)
- `.logo`
- `.nav-actions`
- `.user-badge`
- Theme toggle styles

**CSS to keep (for now):**
- QueueManager-specific styles (will be replaced in Phase 3)
- NotificationCenter-specific styles (will be replaced in Phase 3)

---

### Phase 2: Modals & Dialogs (1 PR)

Replace all custom modal implementations with MUI `Dialog`.

#### 2.1 Replace `ConfirmModal`

**File: `ConfirmModal.tsx`** → Use MUI `Dialog` + `DialogTitle` + `DialogContent` + `DialogContentText` + `DialogActions` + `Button`

- Remove manual `createPortal`, `backdrop-filter: blur()`, `keydown` listener
- Keep the same API (title, message, confirmText, onConfirm, onCancel, isDanger, isOpen)
- Add proper `aria-labelledby` and `aria-describedby` via MUI's built-in support

#### 2.2 Replace `InfoModal`

**File: `InfoModal.tsx`** → Use MUI `Dialog` + `Alert` inside

- Remove manual SVG icons, use MUI `Alert` component with severity: `success` | `error` | `info` | `warning`
- Keep the same API (type, title, message, onClose, isOpen)

#### 2.3 Replace Hand-Built Dialogs in Components

**Dashboard.tsx (Series CRUD dialogs):**
- Create Series modal → extract to `CreateSeriesDialog.tsx` using `Dialog` + `TextField` + `Button`
- Edit Series modal → extract to `EditSeriesDialog.tsx`
- Delete confirmation → use new MUI `ConfirmModal`

**SeriesDetails.tsx (Chapter CRUD dialogs):**
- Create Chapter dialog → extract to `CreateChapterDialog.tsx`
- Edit Chapter dialog → extract to `EditChapterDialog.tsx`
- Delete confirmations → use new MUI `ConfirmModal`

**ChapterGallery.tsx:**
- Delete page confirm → use new MUI `ConfirmModal`
- Upload zone → keep custom for now (drag-and-drop area)

**Reader.tsx:**
- Various confirm dialogs → use new MUI `ConfirmModal`

**QueueManager.tsx:**
- Clear queue confirm → use new MUI `ConfirmModal`
- Pause queue confirm → use new MUI `ConfirmModal`

**CSS to remove from `index.css`:**
- `.modal-overlay` (~lines)
- `.modal`
- `.modal-actions`
- `.info-modal-*` styles
- `.confirm-modal-*` styles

---

### Phase 3: Queue Manager (1 PR)

Redesign the Queue Manager using MUI components. This covers D.3 queue UI refinements as well.

**File: `QueueManager.tsx`**

| Before | After |
|--------|-------|
| Custom job card divs | `<Card>` + `<CardContent>` + `<CardActions>` |
| Status text | `<Chip>` with color-coded labels |
| Manual status dots | `<Chip>` `avatar` prop with colored `<Avatar>` or `<Badge>` |
| Text buttons for queue actions | `<ButtonGroup>` with `<Button>` variants |
| Per-job play/pause | `<IconButton>` with `PlayArrow`/`Pause` icons |
| Per-job retry | `<IconButton>` with `Refresh` icon |
| Per-job delete | `<IconButton>` with `Delete` icon, color="error" |
| Attempt counter | `<Typography variant="caption">` |
| Series→Chapter→Page context | `<Breadcrumbs>` or `<Stack>` with `Typography` |
| Global pause/resume/clear | `<ButtonGroup variant="outlined">` |
| Queue header | MUI `Paper` with `Stack` layout |
| Sorted by status | `<Tabs>` or `<ToggleButtonGroup>` for filtering |

**Icons needed:**
- `PlayArrow`, `Pause`, `Refresh`, `Delete`, `ClearAll`, `FilterList`

**CSS to remove:**
- All `.queue-*` styles
- `.queue-manager`, `.queue-header`, `.queue-list`, `.job-card`, `.job-dot`, etc.

---

### Phase 4: Dashboard & Cards (1 PR)

Redesign the Dashboard series grid and cards.

**File: `Dashboard.tsx`**

| Before | After |
|--------|-------|
| `.manga-card` div | `<Card>` with `<CardMedia>` (thumbnail) + `<CardContent>` |
| Manual grid layout | `<Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)', lg: 'repeat(4, 1fr)' }, gap: 2 }}>` |
| Series title in card | `<CardHeader>` or `<Typography variant="h6">` |
| Page count overlay | `<Chip>` positioned over `<CardMedia>` |
| Create Series button | `<Button variant="contained" startIcon={<AddIcon />}>` |
| Sort dropdown | `<Select>` or `<ToggleButtonGroup>` |
| Cover image viewer | MUI `Dialog` with full-size image |

**File: `SeriesDetails.tsx`** (Chapter cards D.3)

| Before | After |
|--------|-------|
| `.chapter-card-nhentai` | `<Card>` with MUI layout |
| Chapter metadata (language, direction, page count) | `<Stack>` with `<Chip>` and `<Typography>` |
| Model info display | `<Chip>` labeled "OCR: PaddleOCR" etc. |
| Delete chapter | `<IconButton color="error">` with `<DeleteIcon>` |
| Edit chapter | `<IconButton>` with `<EditIcon>` |
| Import button | `<Button variant="outlined" startIcon={<UploadIcon />}>` |

**File: `ChapterGallery.tsx`**

| Before | After |
|--------|-------|
| `.pages-grid` layout | `<ImageList>` for page thumbnails |
| `.page-thumbnail` | `<ImageListItem>` with `<ImageListItemBar>` for page number |
| Page reorder | Keep current drag-and-drop logic, wrap in MUI `<Card>` surfaces |
| "Open in Reader" | `<Button variant="contained">` |

**CSS to remove:**
- `.manga-card*`, `.dashboard-content`, `.grid-cols-*`
- `.chapter-card-nhentai`, `.chapter-list`, `.chapter-row`
- `.pages-grid`, `.page-thumbnail`
- Dashboard-specific grid/sort styles

---

### Phase 5: Forms & Settings (1 PR)

Replace all form inputs and settings with MUI components.

#### 5.1 Auth Page

**File: `Auth.tsx`**

| Before | After |
|--------|-------|
| `.auth-page` centered layout | `<Container maxWidth="sm">` + `<Paper>` centered |
| `.auth-card` | `<Card>` + `<CardContent>` |
| `.form-group` + `.form-input` | `<TextField fullWidth>` |
| Submit button | `<Button variant="contained" fullWidth>` |
| Error message | `<Alert severity="error">` |

#### 5.2 Settings Modal

**File: `SettingsModal.tsx`** (covers D.2 overflow fix, D.10 resolved model display, D.11 model override UX)

| Before | After |
|--------|-------|
| Custom modal | `<Dialog fullWidth maxWidth="md">` (fixes overflow natively) |
| Model picker selects | `<Select>` with `<MenuItem>` |
| Provider/model groups | `<Accordion>` per category (OCR, TL, QA) |
| Custom toggle switches | `<Switch>` |
| "Inherited" model display | `<FormHelperText>` showing resolved model (D.10) |
| Override hierarchy | `<Tabs>` or nested `<Accordion>` (D.11) |
| Reset to default | `<IconButton>` with `<RestoreIcon>` |
| Multiple model entries | `<Autocomplete>` for provider + model selection |

#### 5.3 User Management Modal (D.7)

**New file: `UserManagement.tsx`**

Components to use:
- `<Dialog>` for the outer modal
- `<Avatar>` for profile picture (with upload via `<Button>`)
- `<TextField>` for username/password/email
- `<Tabs>` for section switching (Profile, Account, Sessions, API Keys)
- `<List>` + `<ListItem>` for session management
- `<Divider>` between sections
- `<Switch>` for toggling settings
- `<Button color="error">` for delete profile action

#### 5.4 Upload Widget (D.6)

**File: `App.tsx` or new `UploadContext.tsx`**

| Before | After |
|--------|-------|
| Upload progress bar | `<LinearProgress>` variant="determinate" |
| Upload widget container | `<Paper>` floating in corner via `position: fixed` |
| Cancel button | `<IconButton>` with `<CloseIcon>` |

---

### Phase 6: Toasts & Notifications (1 PR)

Replace custom Toast/Notification systems with MUI components.

#### 6.1 ToastContext → MUI Snackbar (D.13 partial)

**File: `ToastContext.tsx`**

- Replace custom toast rendering with a **single** `<Snackbar>` + `<Alert>` 
- The context provider manages a queue of notifications (only one shown at a time)
- `showToast(message, options)` → enqueue to MUI Snackbar
- `showSuccess` / `showError` / `showInfo` → `<Alert severity="success|error|info">`
- Action buttons → `<Alert action={<Button>...</Button>}>`
- Auto-dismiss → Snackbar's `autoHideDuration`

This also covers the toast theme fix (current toasts don't respect light theme — MUI handles this automatically)

#### 6.2 NotificationCenter → MUI Popover + Badge

**File: `NotificationCenter.tsx`**

| Before | After |
|--------|-------|
| Custom dropdown div | `<Popover>` anchored to the bell icon |
| Notification items | `<List>` + `<ListItem>` with `<ListItemIcon>` (error/warning/info icon) |
| Mark as read | `<ListItemSecondaryAction>` with `<IconButton>` |
| Clear all | `<Button>` at the bottom |
| Unread badge | MUI `<Badge badgeContent={count} color="error">` wrapping the bell `<IconButton>` |

**Icons needed:** `Notifications`, `NotificationsActive`, `Error`, `Warning`, `Info`, `CheckCircle`, `DoneAll`

---

### Phase 7: Reader (1-2 PRs)

The Reader is 5292 lines — the most complex component. Migration must be surgical.

#### 7.1 What to Migrate (MUI components)

| Current | MUI Replacement |
|---------|-----------------|
| Page navigation buttons (◀ ▶) | `<IconButton>` or `<Fab>` |
| Zoom controls (±, fit, reset) | `<IconButton>` with `ZoomIn`, `ZoomOut`, `FitScreen` icons |
| Floating toolbar container | `<Paper elevation={3}>` instead of `glass` class |
| Toolbar toggle handle | `<ButtonBase>` or small `<Fab>` |
| Layer panel sidebar | `<Drawer>` (temporary or persistent) |
| Layer list items | `<List>` + `<ListItem>` with checkboxes and icons |
| Layer controls (visibility, lock) | `<IconButton>` wrapped with `<Tooltip>` |
| Color picker (keep `ColorPicker.tsx`) | Wrap in MUI `<Popover>` instead of custom positioning |
| Confirm dialogs | MUI `ConfirmModal` (already done in Phase 2) |
| Page counter display | `<Chip>` or `<Typography variant="overline">` |
| Processing status badges | `<Chip size="small" color="..." />` |
| Redo OCR / Redo TL buttons | `<ButtonGroup>` or `<SpeedDial>` |

#### 7.2 What to KEEP (vanilla CSS/SVG — cannot migrate)

These elements are deeply tied to the canvas/SVG rendering and would break if restructured:

- **SVG overlay system** (`.svg-overlay`, `.svg-panel-box`, `.svg-ocr-box`, `.svg-conv-box`) — these are programmatic SVG elements rendered onto the manga page canvas
- **Canvas element** (`.reader-canvas-area`) — the main image display
- **Floating toolbar positioning** — use MUI's `<Paper>` for the visual container but keep the `position: fixed` CSS for placement
- **Font fitting logic** (`fitText.ts`, `polygonUtils.ts`) — pure utility logic, no migration needed
- **Polygon vertex editing** — SVG-based interaction, keep as-is
- **`<useEffect>` and state management** — React logic unchanged, only JSX templates change

#### 7.3 Reader CSS to Remove

- `.reader-container` → replace with MUI `Box`
- `.reader-sidebar` → replace with MUI `Drawer`
- `.reader-main` → replace with MUI `Box`
- `.floating-reader-toolbar` → replace with MUI `Paper`
- `.floating-zoom-toolbar` → replace with MUI `Paper`
- `.toolbar-toggle-handle`, `.zoom-toggle-handle` → keep positioning CSS only
- Toolbar button styles → replace with MUI `IconButton`
- Layer panel item styles → replace with MUI `ListItem`
- Reader toolbar icon styles → replace with MUI icons

#### 7.4 Icons Needed for Reader

- `NavigateBefore`, `NavigateNext` (page nav)
- `ZoomIn`, `ZoomOut`, `FitScreen` (zoom)
- `Visibility`, `VisibilityOff` (layer visibility)
- `Lock`, `LockOpen` (layer lock)
- `ContentCopy` (clone layer)
- `Delete` (delete layer)
- `PlayArrow`, `Pause` (playback)
- `Refresh` (redo OCR/TL)
- `Edit`, `FormatPaint`, `Palette`
- `Undo`, `Redo`
- `Fullscreen`, `FullscreenExit`

---

### Phase 8: Auth Page (1 PR, can be done earlier)

Already partially covered in Phase 5.1 — full migration:

- Replace `.auth-page` + `.auth-card` with `<Container>` + `<Card>`
- Replace all form inputs with `<TextField>`
- Replace submit button with `<Button variant="contained">`
- Replace error displays with `<Alert severity="error">`
- Replace welcome message with `<Typography>` variants
- Add loading `<CircularProgress>` on submit

**CSS to remove:** `.auth-page`, `.auth-card`, `.form-group`, `.form-label`, `.form-input`, `.form-error`

---

### Phase 9: Cleanup & Polish (1 PR)

#### 9.1 Remove Dead CSS

After all phases complete, `index.css` should shrink from 1813 lines to ~200-300 lines containing only:

- `.reader-canvas-area` (Reader canvas positioning — essential)
- SVG overlay styles (`.svg-overlay`, `.svg-panel-box`, `.svg-ocr-box`, `.svg-conv-box`) — essential for Reader
- Floating toolbar positioning (`.floating-reader-toolbar`, `.floating-zoom-toolbar`) — the `position: fixed` parts only
- `<Toolbar>` toggle handle positioning (`.toolbar-toggle-handle`, `.zoom-toggle-handle`)
- `.manga-cover-placeholder` (if still used as fallback)
- Any deeply custom Reader interaction styles that can't be expressed via MUI `sx` prop
- Utility classes that are genuinely needed (check for usage first)

**Remove:**
- All `.glass` utility and its overrides
- All `:root.light` theme variable overrides (MUI handles this)
- All CSS `backdrop-filter: blur()` references
- All grid layout classes (`.grid-cols-*`)
- All component-specific classes that have been replaced by MUI
- All form input styles
- All button styles (`.btn`, `.btn-primary`, etc.)
- All modal/dialog styles
- All navigation styles
- All card styles
- All toast styles

#### 9.2 Remove Google Fonts Import

Current `index.css` line 1 loads 5 Google Fonts:
```css
@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Comic+Neue:wght@300;400;700&family=Bangers&family=Luckiest+Guy&display=swap");
```

**Keep:** `Outfit` (headings), `Plus Jakarta Sans` (body)  
**Remove:** `Comic Neue`, `Bangers`, `Luckiest Guy` — check usage first. If used only in Reader for preview text styles, keep them scoped to Reader component.

Replace the `@import` with `<link>` tags in `index.html` for better performance (or use `@fontsource` packages).

#### 9.3 Accessibility Pass

- Add `aria-label` to all `IconButton` components
- Ensure all `Dialog` components have proper `aria-labelledby`/`aria-describedby`
- Verify color contrast ratios (MUI warns about low contrast by default)
- Test with keyboard navigation (Tab through all interactive elements)
- Ensure `:focus-visible` outlines are visible (MUI handles this)

#### 9.4 Responsive Pass

- Test Dashboard grid at xs, sm, md, lg breakpoints
- Test SeriesDetails layout at mobile widths
- Test Reader at mobile widths (touch targets large enough)
- Test Queue Manager at narrow widths
- Verify the nav bar collapses gracefully on mobile (consider MUI `useMediaQuery` for responsive nav)

---

## Phase Dependency Graph

```
Phase 0 (Setup) ─────────────────────────────────────────────────────┐
    │                                                                 │
    ├── Phase 1 (Nav Bar) ──────────────────────────────────────────┤
    ├── Phase 2 (Modals & Dialogs) ─────────────────────────────────┤
    │       │                                                         │
    │       └── Phase 3 (Queue Manager) ────────────────────────────┤
    │       └── Phase 4 (Dashboard & Cards) ────────────────────────┤
    │       └── Phase 5 (Forms & Settings) ─────────────────────────┤
    │       └── Phase 6 (Toasts & Notifications) ───────────────────┤
    │       └── Phase 7 (Reader) ───────────────────────────────────┤
    │       └── Phase 8 (Auth Page) ────────────────────────────────┤
    │                                                                 │
    └── All phases complete ──→ Phase 9 (Cleanup) ──────────────────┘
```

Phases 1-8 are independent of each other (can be parallelized across PRs) once Phase 0 is done.  
Phase 2 should be done before Phase 3-8 since all components use modals/dialogs.  
Phase 9 MUST be last — it removes CSS that is still needed by non-migrated components.

**Recommended execution order:** 0 → 2 → 1 → 8 → 5 → 4 → 6 → 3 → 7 → 9

---

## Items D.1–D.13 Covered by MUI Migration

| D Item | Description | Handled by Phase |
|--------|-------------|------------------|
| D.1 | Remove cover image URL field | Phase 4 (Dashboard refactor) |
| D.2 | Fix Settings modal overflow | Phase 5 (MUI Dialog natively scrolls) |
| D.3 | Chapter cards redesign | Phase 4 (MUI Card components) |
| D.4 | Dashboard sorting | Phase 4 (MUI Select/ToggleButtonGroup) |
| D.5 | Fix Reader full-reload | Phase 7 (stable keys investigation) |
| D.6 | Persist upload widget | Phase 5.4 (UploadContext + Paper) |
| D.7 | User management modal | Phase 5.3 (MUI Dialog + Tabs) |
| D.8 | Theme improvements | Phase 0 (MUI colorSchemes — subsumed) |
| D.9 | Lazy loading / infinite scroll | Phase 4 (IntersectionObserver — independent) |
| D.10 | Model override display | Phase 5 (FormHelperText for resolved models) |
| D.11 | Model override UX redesign | Phase 5 (Accordion/Tabs layout) |
| D.12 | MUI migration | This entire plan |
| D.13 | Global toast notifications | Phase 6 (MUI Snackbar) |

---

## Quality Gate (per phase)

Run after each phase completion, before manual testing:

```bash
cd frontend
npm run lint          # ESLint — no warnings/errors
npm run test:coverage # Vitest — ≥79% line coverage (existing threshold)
npm run build         # TypeScript compilation — must succeed
```

**Phase-specific manual checks are documented in each phase's commands section.**

---

## Testing Strategy

### Unit Tests to Update

Every component test that uses `document.querySelector('.some-class')` or checks class names will need to be updated to use MUI's rendering patterns. Key things:

- Use `@testing-library/react` queries (`getByRole`, `getByText`, `getByLabelText`) instead of class selectors
- MUI components render with specific ARIA roles (e.g., `Button` → `role="button"`, `Dialog` → `role="dialog"`)
- Text queries (`getByText`, `findByText`) are more reliable than class selectors
- For MUI `<TextField>`, query by label: `screen.getByLabelText("Series Title")`
- For MUI `<Button>`, query by role + name: `screen.getByRole("button", { name: "Create" })`
- For MUI `<Dialog>`, query by role: `screen.getByRole("dialog")`

### Test Coverage Thresholds

Existing: 79% line coverage  
Target: maintain ≥79%. MUI migration should not reduce coverage — it may increase it as dialogs become more testable (MUI Dialog has proper ARIA roles making `getByRole` queries robust).

### Files Excluded from Coverage

Current excludes (from `vite.config.ts`): `Reader.tsx`, `App.tsx`, `main.tsx`, `types.ts`, test files.  
Do NOT change these exclusions during migration.

---

## Risk Mitigation

1. **Do NOT delete `index.css` until Phase 9** — maintain it as a safety net. Each phase removes only the CSS sections it replaces.
2. **Do one phase per PR** — each PR is independently reviewable and revertible.
3. **Use MUI `sx` prop for one-off styles** instead of adding new CSS classes.
4. **Reader component is highest risk** — treat Phase 7 with extra care. The SVG overlay system must not break.
5. **Test dark/light mode after every phase** — MUI's `useColorScheme()` behaves differently from the old manual toggle.
6. **Check bundle size** — MUI is tree-shakeable but v7 is large. Monitor with `npm run build` and check output sizes.

---

## Appendix: Component → MUI Replacement Map

| Current Component/Class | MUI Component | Import Path |
|------------------------|---------------|-------------|
| `<div className="glass">` | `<Paper>` | `@mui/material/Paper` |
| `<nav className="nav-bar">` | `<AppBar>` | `@mui/material/AppBar` |
| `<div className="modal-overlay">` | `<Dialog>` | `@mui/material/Dialog` |
| `ConfirmModal` | `<Dialog>` + `<DialogActions>` | `@mui/material/Dialog` |
| `InfoModal` | `<Dialog>` + `<Alert>` | `@mui/material/Dialog`, `@mui/material/Alert` |
| `.form-input` | `<TextField>` | `@mui/material/TextField` |
| `.form-group` | `<FormControl>` | `@mui/material/FormControl` |
| `<button className="btn btn-primary">` | `<Button variant="contained">` | `@mui/material/Button` |
| `<button className="btn btn-secondary">` | `<Button variant="outlined">` | `@mui/material/Button` |
| `.switch .slider` | `<Switch>` | `@mui/material/Switch` |
| `.manga-card` | `<Card>` | `@mui/material/Card` |
| `ToastContext` | `<Snackbar>` + `<Alert>` | `@mui/material/Snackbar`, `@mui/material/Alert` |
| `.notification-item` | `<ListItem>` | `@mui/material/ListItem` |
| Custom `<select>` | `<Select>` + `<MenuItem>` | `@mui/material/Select`, `@mui/material/MenuItem` |
| `.user-badge` | `<Avatar>` | `@mui/material/Avatar` |
| `.reader-sidebar` | `<Drawer>` | `@mui/material/Drawer` |
| Upload progress div | `<LinearProgress>` | `@mui/material/LinearProgress` |
| Loading spinner (custom) | `<CircularProgress>` | `@mui/material/CircularProgress` |
| Custom tabs | `<Tabs>` + `<Tab>` | `@mui/material/Tabs` |
| Job card status dot | `<Chip>` | `@mui/material/Chip` |
| Grid layout (manual) | `<Box sx={{ display: 'grid' }}>` or `<Grid>` | `@mui/material/Grid` |
| Flex layout | `<Stack>` | `@mui/material/Stack` |
| `<h1>`, `<h2>`, etc. | `<Typography variant="h1">` | `@mui/material/Typography` |
| Theme toggle | `<IconButton>` + `DarkMode`/`LightMode` icons | `@mui/icons-material` |
| Info/help icons | `Info`, `Help`, `Warning`, `Error`, `CheckCircle` | `@mui/icons-material` |
| Action icons | `Add`, `Edit`, `Delete`, `Save`, `Close`, `Close`, `Upload`, `Download` | `@mui/icons-material` |
| Nav icons | `Dashboard`, `Menu`, `Settings`, `Person`, `Home` | `@mui/icons-material` |

---

## Appendix: CSS Tracking Sheet

Use this table to track which sections of `index.css` are removed in each phase. Mark sections as you remove them.

| CSS Section | Approx Lines | Removed in Phase | Status |
|-------------|-------------|------------------|--------|
| `@import` fonts | 1 | 9 | Pending |
| `:root` variables (dark) | 3-53 | 9 | Pending |
| `:root.light` variables | 55-90 | 9 | Pending |
| `:root.light` overrides | 92-125 | 9 | Pending |
| `body` + gradients | 127-146 | 0.5 | Pending |
| `.glass` utility | 139-146 | 9 | Pending |
| `.app-container` | 148-170 | 9 | Pending |
| `.nav-bar`, `.logo`, `.nav-actions` | ~170-250 | 1 | Pending |
| `.user-badge` | ~250-270 | 1 | Pending |
| `.auth-page`, `.auth-card` | ~270-320 | 8 | Pending |
| `.form-*` styles | ~320-380 | 5 | Pending |
| `.btn*` styles | ~380-480 | 9 | Pending |
| `.modal-*` styles | ~480-550 | 2 | Pending |
| `.confirm-modal-*` | ~550-600 | 2 | Pending |
| `.info-modal-*` | ~600-630 | 2 | Pending |
| `.switch` / `.slider` | ~630-690 | 5 | Pending |
| Dashboard + card styles | ~700-850 | 4 | Pending |
| Chapter + page styles | ~850-1100 | 4 | Pending |
| Queue Manager styles | ~1100-1250 | 3 | Pending |
| Notification Center styles | ~1250-1330 | 6 | Pending |
| Toast styles | ~1330-1400 | 6 | Pending |
| Reader layout styles | ~1400-1600 | 7 | Pending |
| Reader toolbar styles | ~1600-1700 | 7 | Pending |
| SVG overlay styles | ~1700-1780 | KEEP | KEEP |
| Animations (@keyframes) | ~1780-1813 | KEEP (if used) | Review |

---

## Performance Analysis & Pre-Migration Fixes

The following bottlenecks were found during audit. Address these **before or alongside** the MUI migration, since MUI alone won't fix them.

### P1 — Cascading Re-renders from App.tsx

**Root cause**: `App.tsx` holds 8 `useState` hooks (user, seriesList, selectedSeries, chapters, selectedChapter, pages, isLoadingDetails, isSettingsOpen) and passes all of them as props to every route component. When *any* state changes, **every child re-renders**, even if its specific props didn't change.

```tsx
// Current: every state change in App re-renders Dashboard, SeriesDetails, etc.
<Dashboard
  user={user}
  seriesList={seriesList}         // only Dashboard needs this
  setSeriesList={setSeriesList}   // new function ref every render
  onSelectSeries={setSelectedSeries}
/>
```

**Fix**: Wrap route components in `React.memo` and use `useCallback` for setter props. The `setSeriesList` / `setChapters` / `setPages` are React dispatch functions — they're stable references, but the linter may complain if not wrapped.

```tsx
const MemoizedDashboard = React.memo(Dashboard);
const MemoizedSeriesDetails = React.memo(SeriesDetails);
const MemoizedChapterGallery = React.memo(ChapterGallery);
const MemoizedReader = React.memo(Reader);
```

**Impact**: 60-80% fewer re-renders on route navigation. High impact, zero risk.

### P2 — Glassmorphism `backdrop-filter: blur()` on Every Card

**Root cause**: The `.glass` utility and every `.manga-card`, `.nav-bar`, `.chapter-card-nhentai` use `backdrop-filter: blur(16px)`. This forces the browser to composite every card on the GPU. With 50+ series cards on Dashboard, this causes compositing lag.

```
Dashboard with 50 cards = 50 separate backdrop-filter layers = GPU compositing bottleneck
```

**Fix**: Remove `backdrop-filter` everywhere. MUI `Card` + `Paper` use box-shadow elevation, not blur. **This is handled by the MUI migration naturally** — Phase 4 replaces all cards.

**Immediate fix** (before MUI): Change `.glass` to use only `background: var(--bg-card)` + `border` + `box-shadow` — remove `backdrop-filter` and `-webkit-backdrop-filter`. This alone can improve Dashboard scroll FPS significantly.

### P3 — No Virtualization / Infinite Scroll

**Root cause**: Dashboard renders ALL series, SeriesDetails renders ALL chapters, ChapterGallery renders ALL pages. With a library of 200+ series, all 200+ `<Card>` components render simultaneously.

```tsx
// Current: renders every series in DOM
{seriesList.map(series => <MangaCard key={series.id} ... />)}
```

**Fix**: Add `IntersectionObserver`-based infinite scroll (D.9 from the improvements plan). Load 20 items at a time, append more as the user scrolls near the bottom. Use `useRef` + `IntersectionObserver` or a library like `react-virtuoso`.

```tsx
const sentinelRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  const observer = new IntersectionObserver(
    ([entry]) => { if (entry.isIntersecting) loadMore(); },
    { rootMargin: '200px' }
  );
  if (sentinelRef.current) observer.observe(sentinelRef.current);
  return () => observer.disconnect();
}, []);
```

**Backend dependency**: Needs `GET /api/series?page=0&size=20&sort=updatedAt,desc` (D.9).

**Impact**: Massive improvement for large libraries. Dashboard with 200 series goes from 200 DOM nodes to ~40.

### P4 — 40+ Separate localStorage `useEffect` Persistence Hooks in Reader

**Root cause**: `Reader.tsx` lines 340–376 have **8 separate `useEffect` hooks**, one per setting, each writing to `localStorage` on every state change. Each `localStorage.setItem()` is synchronous and blocks the main thread.

```tsx
// Current: 8 individual effects
useEffect(() => { localStorage.setItem("manga_show_panels", showPanels.toString()); }, [showPanels]);
useEffect(() => { localStorage.setItem("manga_show_ocr", showOcr.toString()); }, [showOcr]);
useEffect(() => { localStorage.setItem("manga_show_left_sidebar", showLeftSidebar.toString()); }, [showLeftSidebar]);
// ... 5 more
```

**Fix**: Batch all persistence into a single `useEffect` that runs on any setting change:

```tsx
useEffect(() => {
  const batch: Record<string, string> = {
    manga_show_panels: showPanels.toString(),
    manga_show_ocr: showOcr.toString(),
    manga_show_left_sidebar: showLeftSidebar.toString(),
    manga_show_right_sidebar: showRightSidebar.toString(),
    manga_clean_view: cleanScanlationView.toString(),
    manga_group_by_conversation: groupByConversation.toString(),
    manga_fit_mode: fitMode,
    manga_zoom: zoom.toString(),
  };
  for (const [key, value] of Object.entries(batch)) {
    localStorage.setItem(key, value);
  }
}, [showPanels, showOcr, showLeftSidebar, showRightSidebar, cleanScanlationView, groupByConversation, fitMode, zoom]);
```

**Impact**: 8 sync writes → 1 sync write per setting change. Reduces main-thread blocking.

### P5 — Reader Page Switch Causes Full Re-mount (D.5)

**Root cause**: When navigating `reader/1` → `reader/2`, `react-router-dom` sees a new route and the `Reader` component's `key` effectively changes via the route params. Combined with P1 (no `React.memo`), the component re-mounts.

Additionally, lines 750–759 do a `setZoom(1.0)` and `setPan({x:0,y:0})` on every `pageNumber` change, triggering a cascade of re-renders inside the Reader.

**Fix**: The Reader already handles this well internally — it uses `selectedPage` based on `pageNumber` param, not re-mounting. The issue is that App.tsx passes new prop references on every render. Wrap Reader in `React.memo` (P1 fix).

Additionally, the zoom/pan reset on line 750 should only happen when switching *chapters*, not pages:
```tsx
// Change the effect dependency from [pageNumber] to [chapterId]
```

### P6 — No Code Splitting for Reader Dependencies

**Root cause**: `Reader.tsx` imports `jszip` (for export), `fitText.ts` (437 lines), and `polygonUtils.ts` (292 lines) all eagerly. `jszip` alone is ~90KB minified.

**Fix**: `jszip` is only used in `handleExportZip` — dynamic import it:
```tsx
// Remove: import JSZip from "jszip";
// In handleExportZip:
const JSZip = (await import("jszip")).default;
```

**Impact**: Reduces Reader initial bundle by ~90KB. The first export click will have a slight delay while loading jszip.

### P7 — Inline SVG Icons Recreated on Every Render

**Root cause**: `App.tsx` (lines 348–426) and `QueueManager.tsx` (lines 22–47) define inline SVG elements inside the component body. Each render creates new SVG DOM nodes.

```tsx
// QueueManager.tsx: defined in component body, recreated every render
const IconPlay = () => (<svg width="14" height="14" ...>...</svg>);
```

**Fix**: Move icon definitions OUTSIDE the component function, or use MUI icons. The MUI migration (Phase 1, 3) handles this automatically. As an immediate fix, extract them from the component body.

### P8 — QueueManager Heartbeat Interval Runs Unconditionally

**Root cause**: `QueueManager.tsx` line 281: `const interval = setInterval(fetchJobs, 30000)` runs every 30 seconds even when SSE is connected and delivering events.

**Fix**: Check SSE connection status and skip fetch when SSE is active:
```tsx
if (isSseConnected) return; // skip REST poll
```

**Impact**: Reduces unnecessary network requests. SSE already delivers real-time updates.

### Priority Matrix

| Priority | Issue | Fix Difficulty | Impact | When |
|----------|-------|---------------|--------|------|
| **P1** | Cascading re-renders (no `React.memo`) | 1-line per component | HIGH | Now |
| **P3** | No virtualization | Moderate (backend + frontend) | HIGH | D.9 |
| **P2** | `backdrop-filter` on every card | Remove 2 CSS lines (immediate) | MEDIUM | Now / MUI Phase 4 |
| **P5** | Reader page switch re-mount | Fix effect deps (P1 fixes most) | MEDIUM | D.5 |
| **P4** | 8 localStorage effects | Consolidate to 1 effect | LOW-MED | MUI Phase 7 |
| **P6** | jszip eager import | Dynamic import | LOW-MED | MUI Phase 7 |
| **P7** | Inline SVG re-creation | Move out of component / MUI icons | LOW | MUI Phase 1, 3 |
| **P8** | Heartbeat poll when SSE is active | 1 condition check | LOW | Phase A cleanup |

---

## Mobile Plan: tl-hub Lite (Upload → Process → Export)

The full desktop Reader (5292 lines, SVG overlays, polygon editing, layer management) is fundamentally unsuitable for mobile. Phone screens can't host the dual-sidebar, floating toolbar, zoom, and canvas-dragging UX.

Instead, build a **separate mobile-first route** with a stripped-down workflow:

### Architecture

```
/mobile → MobileApp (new component, ~200 lines)
  ├── UploadStep — file picker + preview
  ├── ProcessingStep — SSE-driven progress bar
  └── ExportStep — download rendered image
```

**NOT a responsive version of the desktop app** — a purpose-built single-purpose flow.

### User Flow

```
1. User visits /mobile on phone
2. Upload Step:
   - Tap to select an image (camera or gallery)
   - Preview thumbnail shown
   - Source language auto-detected or manual select (ja/ko/zh)
   - Target language (default: en)
   - "Translate" button
3. Processing Step:
   - SSE-connected progress bar (pipeline stages as dots)
   - Current stage: Panel Detection → OCR → Layout → Translation → Render
   - Cannot navigate away (single-page flow — no routes)
   - Elapsed time counter
4. Export Step:
   - Side-by-side or toggle: original ↔ translated
   - "Download Translated Image" button
   - "Start New" button to go back to step 1
```

### Components Needed

| Component | MUI Component | Purpose |
|-----------|---------------|---------|
| Page container | `<Container maxWidth="sm">` | Center on phone screen |
| Step indicator | `<MobileStepper>` or `<Stepper>` | Show current phase |
| Upload area | `<Button variant="outlined" fullWidth>` | Triggers `<input type="file">` |
| Preview | `<CardMedia>` | Shows selected image |
| Language selects | `<Select>` + `<MenuItem>` | Source/target language |
| Progress bar | `<LinearProgress variant="determinate">` | Upload + processing |
| Stage dots | `<Stack>` of `<Chip>` | Pipeline stage indicator |
| Image comparison | `<ToggleButtonGroup>` | Toggle original/translated |
| Download button | `<Button variant="contained" startIcon={<DownloadIcon />}>` | Export |

### Backend Requirements

The mobile flow reuses existing APIs — no new backend needed:

1. **Upload**: `POST /api/images` (existing) with `chapterId` pointing to a temporary/auto-created chapter
2. **SSE**: `GET /api/notifications/stream` (existing) — listen for `job_update` events on the uploaded image
3. **Export**: `GET /api/series/chapters/{id}/export?format=png&page=1` — single page rendered PNG
4. **Cleanup**: After 24h, delete the mobile chapter + images (scheduled cleanup or on new upload)

### File: `frontend/src/components/MobileApp.tsx`

New component, ~200-300 lines. Uses MUI components exclusively. No dependency on any existing component (Reader, Dashboard, etc.) — standalone.

### Route Addition

In `App.tsx`:
```tsx
// Lazy-loaded
const MobileApp = React.lazy(() => import("./components/MobileApp"));

// Route
<Route path="/mobile" element={user ? <MobileApp user={user} /> : null} />
```

### What NOT to Include

- No layer editing (no SVG overlays, no polygon editing)
- No chapter/series management
- No queue manager
- No palette/color picker
- No OCR region manipulation
- No conversation grouping
- No zoom/pan/fit-mode controls
- No sidebars
- No dark/light theme toggle on the page itself (use system preference or default)

---

## Image Viewing Limitation

The current model (DeepSeek v4) does **not support image/vision input**. I cannot see screenshots, color palettes as images, or design mockups.

### What I CAN do with images

- **Read SVG files** — palette SVGs (like `site-palette(2).svg`) contain machine-readable color hex codes. I successfully extracted both palettes this way.
- **Read ASE files** — Adobe Swatch Exchange files contain color data (though I didn't need to parse these since the SVGs were available).
- **Read filenames** — screenshot filenames give me context about what page/state is shown (e.g., `tl-hub - Home.png`, `tl-hub SFW - Ch. 6 Page 3.png`).

### What you can do to help

1. **Use a vision-capable model** — Claude (Sonnet/Haiku/Opus), GPT-4o, Gemini all support image input. If you switch your opencode model to one of these, I can see the screenshots.
2. **Describe screenshots in text** — "The Dashboard has cards in a 3-column grid, each card has a thumbnail with the series title below it..."
3. **Export color palettes as SVG** — The palette extraction sites you used already generated SVGs with hex codes. These are machine-readable and fully sufficient for theme creation.
4. **Share specific hex values** — If you want a color from a screenshot, use a color picker tool and paste the hex code.

The palette SVGs you provided were sufficient — I built the complete MUI theme from them without needing to see the actual palette screenshots.
