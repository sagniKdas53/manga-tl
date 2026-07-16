import React, { useEffect } from "react";
import { ThemeProvider, useColorScheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import theme from "../theme";

function ThemeSync() {
  const { mode, setMode } = useColorScheme();
  useEffect(() => {
    const saved = localStorage.getItem("manga_theme");
    if (saved === "light" && mode !== "light") setMode("light");
    else if (!saved && mode !== "dark") setMode("dark");
  }, [mode, setMode]);

  useEffect(() => {
    if (mode) localStorage.setItem("manga_theme", mode);
  }, [mode]);
  return null;
}

export function RootThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ThemeSync />
      {children}
    </ThemeProvider>
  );
}
