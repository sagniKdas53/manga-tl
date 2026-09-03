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
    // AUDIT-F21: the dark scheme was reported as harsh to read on a tablet at night, and it
    // measured that way. `#fefefe` on `#0f0f0f` is **19.0:1** — WCAG AA asks 4.5:1 and AAA asks
    // 7:1, so body text was at nearly triple the strictest legibility threshold. Past a point
    // more contrast stops helping and starts hurting: glyph edges bloom on an emissive panel,
    // which is what "harsh" describes. Every accent also sat at 84–100% saturation, and a
    // saturated hue on a near-black field is the combination that appears to vibrate.
    //
    // So: lift the floor off pure black, pull white back to a warm off-white, and desaturate the
    // accents ~20 points without moving their hue, so nothing changes identity. Body text lands
    // at 13.7:1 — still above AAA with room, but out of the bloom range. Every pair below is
    // asserted in `theme.test.ts`, with both an AA floor and a halation ceiling, so this cannot
    // drift back by accident in either direction.
    //
    // Surfaces move together: `default` and `paper` were 1.15:1 apart, so a card barely read as
    // a card. They are 1.20:1 apart now — Material's own dark baseline is 1.24:1, and going
    // further starts making `paper` look grey rather than raised.
    dark: {
      palette: {
        mode: "dark",
        primary: { main: "#df6d87" },
        secondary: { main: "#e3b782" },
        error: { main: "#df6d87" },
        warning: { main: "#e3b782" },
        success: { main: "#2bc591" },
        info: { main: "#86c2ea" },
        background: {
          default: "#16161a",
          paper: "#26262c",
        },
        text: {
          primary: "#e2e0dd",
          secondary: "#a9a6a2",
          disabled: "#8a8681",
        },
        divider: "rgba(226,224,221,0.14)",
        conversation: { main: "#6797e4" },
      },
    },
  },
  cssVariables: {
    // MUI v9 moved this under `cssVariables`; at the top level it was silently ignored,
    // which put the selector back on its "media" default -- the exact bypass the comment above
    // exists to prevent.
    colorSchemeSelector: "class",
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
          textTransform: "none",
          borderRadius: 8,
          transition:
            "background-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out",
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
    MuiPaper: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          backgroundImage: "none",
          boxShadow:
            "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
          // AUDIT-F21: 0.4 black under a surface that is itself near-black mostly reads as
          // grime rather than elevation. The surfaces carry the depth now (see the dark
          // palette above); the shadow only has to soften the edge.
          ...t.applyStyles("dark", {
            boxShadow:
              "0 1px 3px 0 rgb(0 0 0 / 0.28), 0 1px 2px -1px rgb(0 0 0 / 0.28)",
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
          borderBottom: `1px solid ${t.palette.divider}`,
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
