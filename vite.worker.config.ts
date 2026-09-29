/**
 * Bundles apps/api/src/worker.mjs into dist/server/index.js for a worker host.
 * This builds the server bundle; it does not publish it.
 */
import { defineConfig } from "vite";
export default defineConfig({
  build: {
    ssr: "apps/api/src/worker.mjs",
    outDir: "dist/server",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "index.js" } },
  },
});
