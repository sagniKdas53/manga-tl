import { createTheme } from "@mui/material/styles";

export function themeObj(mode: "light" | "dark") {
  return createTheme({
    palette: {
      mode,
      primary: { main: mode === "dark" ? "#ee2553" : "#0197fc" },
      secondary: { main: mode === "dark" ? "#f1af5f" : "#e4a243" },
      error: { main: mode === "dark" ? "#ee2553" : "#fd4060" },
      warning: { main: mode === "dark" ? "#f1af5f" : "#e4a243" },
      success: { main: "#10b981" },
      info: { main: mode === "dark" ? "#6ac2fd" : "#0197fc" },
      background: {
        default: mode === "dark" ? "#0d0d0d" : "#f5f5f5",
        paper: mode === "dark" ? "#1a1a1a" : "#ffffff",
      },
      text: {
        primary: mode === "dark" ? "#fefefe" : "#343333",
        secondary: mode === "dark" ? "#afafaf" : "#b0b0b0",
        disabled: mode === "dark" ? "#6c6c6c" : "#786e6a",
      },
      divider:
        mode === "dark" ? "rgba(254,254,254,0.12)" : "rgba(52,51,51,0.12)",
      conversation: {
        main: mode === "dark" ? "#3b82f6" : "#2563eb",
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
          root: {
            backgroundImage: "none",
            boxShadow:
              mode === "dark"
                ? "0 1px 3px 0 rgb(0 0 0 / 0.4), 0 1px 2px -1px rgb(0 0 0 / 0.4)"
                : "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            borderBottom: `1px solid ${mode === "dark" ? "#333333" : "#e0e0e0"}`,
          },
        },
      },
      MuiTable: {
        defaultProps: {
          size: "small",
        },
      },
    },
  });
}
