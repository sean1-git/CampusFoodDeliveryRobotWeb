/**
 * Configures the React frontend build and writes it to dist/client.
 * During development and preview, forwards /api requests to the local backend on port 8787.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  preview: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { outDir: "dist/client" },
});
