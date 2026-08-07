import { createTheme } from "@mui/material/styles";

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
  colorSchemeSelector: "class",
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
    dark: {
      palette: {
        mode: "dark",
        primary: { main: "#ee2553" },
        secondary: { main: "#f1af5f" },
        error: { main: "#ee2553" },
        warning: { main: "#f1af5f" },
        success: { main: "#10b981" },
        info: { main: "#6ac2fd" },
        background: {
          default: "#0f0f0f",
          paper: "#1e1e1e",
        },
        text: {
          primary: "#fefefe",
          secondary: "#afafaf",
          disabled: "#6c6c6c",
        },
        divider: "rgba(254,254,254,0.12)",
        conversation: { main: "#3b82f6" },
      },
    },
  },
  cssVariables: true,
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
          ...t.applyStyles("dark", {
            boxShadow:
              "0 1px 3px 0 rgb(0 0 0 / 0.4), 0 1px 2px -1px rgb(0 0 0 / 0.4)",
          }),
        }),
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderBottom: "1px solid #e0e0e0",
          ...t.applyStyles("dark", {
            borderBottom: "1px solid #333333",
          }),
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
