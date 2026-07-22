/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || "/",
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080/tlhub",
        changeOrigin: true,
      },
      "/tlhub": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "src/main.tsx",
        "src/App.tsx",
        "src/types.ts",
        "src/components/Reader.tsx",
        "vitest.setup.ts",
        "**/*.test.{ts,tsx}",
        "dist/**",
      ],
      thresholds: {
        lines: 79,
      },
    },
  },
  build: {
    minify: "esbuild",
    esbuild: {
      drop: ["console", "debugger"],
    },
  },
});
