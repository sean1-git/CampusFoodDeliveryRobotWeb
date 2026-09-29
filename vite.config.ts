/**
 * Configures the React frontend build and writes it to dist/client.
 * During development and preview, forwards /api requests to the local backend on port 8787.
 */
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL("./apps/web/", import.meta.url)),
  // Keep root-level .env files and shared source imports working after grouping the app.
  envDir: repositoryRoot,
  plugins: [react()],
  server: { fs: { allow: [repositoryRoot] }, proxy: { "/api": "http://127.0.0.1:8787" } },
  preview: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: {
    outDir: fileURLToPath(new URL(mode === "native" ? "./dist/native/" : "./dist/client/", import.meta.url)),
    emptyOutDir: true,
  },
}));
