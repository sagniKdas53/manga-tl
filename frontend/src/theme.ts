import { createTheme } from "@mui/material/styles";

const darkPalette = {
  primary: { main: "#ee2553" },
  secondary: { main: "#f1af5f" },
  background: {
    default: "#1f1f1f",
    paper: "#2a2a2a",
  },
  text: {
    primary: "#fefefe",
    secondary: "#afafaf",
    disabled: "#6c6c6c",
  },
  divider: "rgba(254,254,254,0.12)",
  error: { main: "#ee2553" }, // reuse primary as error in dark
  warning: { main: "#f1af5f" },
  success: { main: "#10b981" },
  info: { main: "#6ac2fd" },
};

const lightPalette = {
  primary: { main: "#0197fc" },
  secondary: { main: "#e4a243" },
  background: {
    default: "#f5f5f5",
    paper: "#ffffff",
  },
  text: {
    primary: "#343333",
    secondary: "#b0b0b0",
    disabled: "#786e6a",
  },
  divider: "rgba(52,51,51,0.12)",
  error: { main: "#fd4060" },
  warning: { main: "#e4a243" },
  success: { main: "#10b981" },
  info: { main: "#0197fc" },
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
          textTransform: "none", // keep our existing casing style
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
