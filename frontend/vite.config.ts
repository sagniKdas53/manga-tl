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
    testTimeout: 15000,
    setupFiles: "./vitest.setup.ts",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "src/main.tsx",
        "src/App.tsx",
        "src/types.ts",
        "src/components/Reader.tsx",
        "src/assets/**",
        "**/*.svg",
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
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // React core — smallest possible initial chunk
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "vendor-react";
          }
          // MUI + emotion — large but stable; cache well between deploys
          if (
            id.includes("node_modules/@mui/") ||
            id.includes("node_modules/@emotion/")
          ) {
            return "vendor-mui";
          }
          // Router
          if (id.includes("node_modules/react-router")) {
            return "vendor-router";
          }
          // Heavy libs used only in certain routes
          if (id.includes("node_modules/jszip")) {
            return "lib-jszip";
          }
          if (id.includes("node_modules/zod")) {
            return "lib-zod";
          }
        },
      },
    },
  },
});
