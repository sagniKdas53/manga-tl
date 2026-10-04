import { createTheme } from "@mui/material/styles";

// Opt in to MUI's CSS-variables typing. `createTheme` only widens `Theme` with `colorSchemes`,
// `vars` and friends when `CssThemeVariables` says they are enabled -- everything else in this
// file already depends on them at runtime, so without this the theme is built one way and typed
// another, and `theme.colorSchemes` reads as a property that does not exist.
declare module "@mui/material/styles" {
  interface CssThemeVariables {
    enabled: true;
  }
}

// AUDIT-F1: previously `themeObj(mode)`, rebuilt from scratch on every light/dark toggle via
// `useMemo(() => themeObj(mode), [mode])` in App.tsx — a whole new MUI theme object (and a
// re-render of every consumer, re-serialising every Emotion style in the tree) on each toggle.
// `colorSchemes` + `cssVariables: true` switches mode by flipping CSS custom properties
// instead: the theme below is built once, at module scope, and toggling calls MUI's
// `useColorScheme().setMode()` rather than reconstructing anything.
export const theme = createTheme({
  // Without this, MUI defaults to `colorSchemeSelector: "media"` whenever both `light` and
  // `dark` colorSchemes are present — the actual rendered CSS then follows the OS's
  // `prefers-color-scheme`, completely bypassing `setMode()`/the app's own toggle button for
  // anything styled through `theme.palette.*`. `"class"` makes MUI toggle a `.light`/`.dark`
  // class instead — the same class name (and node, `documentElement`) the app's own
  // pre-existing custom-CSS-variable system already toggles in `App.tsx`, so both stay in
  // sync off the same `mode` value without fighting each other.
  colorSchemes: {
    light: {
      palette: {
        mode: "light",
        primary: { main: "#0197fc" },
        secondary: { main: "#e4a243" },
        error: { main: "#fd4060" },
        warning: { main: "#e4a243" },
        success: { main: "#10b981" },
        info: { main: "#0197fc" },
        background: {
          default: "#f5f5f5",
          paper: "#ffffff",
        },
        text: {
          primary: "#343333",
          // AUDIT-F4: light secondary was #b0b0b0 — 2.2:1 on white paper, against a 4.5:1 WCAG
          // AA threshold, which put it below the *disabled* colour's ~5:1. Secondary text was
          // the least legible text in the light theme.
          secondary: "#5f5f5f",
          disabled: "#786e6a",
        },
        divider: "rgba(52,51,51,0.12)",
        conversation: { main: "#2563eb" },
      },
    },
    // AUDIT-F21 set the comfortable band this palette still honours: body text between 7:1 and
    // 15:1, accents at or under 80 % saturation, paper at least 1.18:1 off the page. All of it is
    // asserted in `theme.test.ts`.
    //
    // 2026-10-04 (UI overhaul, #214): the surfaces lose their warm tint and become plain neutral
    // greys, and the accent stops doing two jobs. A pink light enough to read as text on a dark
    // surface (4.5:1) is too light to carry white text as a button fill, and no single colour
    // passes both. So `primary.main` is the text/active pink, and filled primary buttons use
    // `primary.dark` (white text at 4.78:1); see the MuiButton override below. Status colours
    // are for text and the pipeline strip only, never for chip fills.
    dark: {
      palette: {
        mode: "dark",
        primary: { main: "#ea6d8b", dark: "#d6304f", contrastText: "#ffffff" },
        secondary: { main: "#e6b98a" },
        error: { main: "#eb8b65" },
        warning: { main: "#e6b98a" },
        success: { main: "#5fc495" },
        info: { main: "#8cc3ea" },
        background: {
          default: "#171717",
          paper: "#262626",
        },
        text: {
          primary: "#e6e6e6",
          secondary: "#a3a3a3",
          disabled: "#8c8c8c",
        },
        divider: "rgba(255,255,255,0.09)",
        action: {
          hover: "rgba(255,255,255,0.06)",
          selected: "rgba(255,255,255,0.10)",
        },
        conversation: { main: "#8cc3ea" },
      },
    },
  },
  cssVariables: {
    // MUI v9 moved this under `cssVariables`; at the top level it was silently ignored,
    // which put the selector back on its "media" default -- the exact bypass the comment above
    // exists to prevent.
    colorSchemeSelector: "class",
  },
  // One family for everything. Atkinson Hyperlegible Next was drawn for low-vision legibility,
  // which is the job here: small model names and stage labels read on a tablet at night. The
  // CJK fallbacks are for source-language titles. Headings differ by weight and size only.
  typography: {
    fontFamily:
      '"Atkinson Hyperlegible Next", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", system-ui, sans-serif',
    fontSize: 14,
    h1: { fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.01em" },
    h2: { fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.01em" },
    h3: { fontSize: "1.375rem", fontWeight: 700 },
    h4: { fontSize: "1.625rem", fontWeight: 700, letterSpacing: "-0.01em" },
    h5: { fontSize: "1.25rem", fontWeight: 700 },
    h6: { fontSize: "1rem", fontWeight: 700 },
    button: { fontWeight: 600, letterSpacing: 0 },
  },
  shape: {
    borderRadius: 6,
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        // `t.vars`, not `t.palette`: with CSS variables on, `t.palette` holds the light scheme's
        // values, so a dark-mode override built from it paints light-mode colours.
        root: ({ theme: t }) => ({
          textTransform: "none",
          borderRadius: 6,
          transition: "background-color 0.15s ease-in-out",
          variants: [
            // One loud button per view. In dark mode the fill is the deep accent, because the
            // text-pink in `primary.main` cannot carry white text (see the palette note).
            {
              props: { variant: "contained", color: "primary" },
              style: t.applyStyles("dark", {
                backgroundColor: t.vars.palette.primary.dark,
                "&:hover": { backgroundColor: "#c22846" },
              }),
            },
            // Every other action is quiet: a filled grey in dark mode instead of a pink
            // outline. Outlined buttons were the main clutter: every header had four.
            {
              props: { variant: "outlined" },
              style: t.applyStyles("dark", {
                backgroundColor: "#313131",
                borderColor: "transparent",
                color: t.vars.palette.text.primary,
                "&:hover": {
                  backgroundColor: "#3b3b3b",
                  borderColor: "transparent",
                },
                "&.Mui-disabled": {
                  borderColor: "transparent",
                  backgroundColor: "#2b2b2b",
                },
              }),
            },
            {
              props: { variant: "outlined", color: "error" },
              style: t.applyStyles("dark", {
                color: t.vars.palette.error.main,
              }),
            },
          ],
        }),
      },
    },
    MuiChip: {
      styleOverrides: {
        // Metadata pills: one neutral style, no outline. State is said in words, not fills.
        root: ({ theme: t }) => ({
          borderRadius: 4,
          fontWeight: 500,
          ...t.applyStyles("dark", {
            backgroundColor: "#3b3b3b",
            color: "#d9d9d9",
          }),
        }),
        outlined: ({ theme: t }) =>
          t.applyStyles("dark", { borderColor: "transparent" }),
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 10,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 10,
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: ({ theme: t }) =>
          t.applyStyles("dark", { backgroundColor: "#313131" }),
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { fontSize: "0.75rem", fontWeight: 500 },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          backgroundImage: "none",
          boxShadow:
            "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
          // No shadows in dark mode: a shadow under a near-black surface reads as grime. The
          // surface steps (page, panel, raised) carry the depth.
          ...t.applyStyles("dark", {
            boxShadow: "none",
          }),
        }),
      },
    },
    MuiTableCell: {
      styleOverrides: {
        // AUDIT-F21: these were two hardcoded greys, so the one place the dark scheme is meant
        // to be tunable did not reach the densest text in the app — the queue and job tables.
        // Both now follow `palette.divider`, which is a token and moves with the scheme.
        root: ({ theme: t }) => ({
          borderBottom: `1px solid ${t.vars.palette.divider}`,
        }),
      },
    },
    MuiTable: {
      defaultProps: {
        size: "small",
      },
    },
  },
});
