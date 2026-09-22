/**
 * Bundles server/worker.mjs into dist/server/index.js for a worker host.
 * This builds the server bundle; it does not publish it.
 */
import { defineConfig } from "vite";
export default defineConfig({
  build: {
    ssr: "server/worker.mjs",
    outDir: "dist/server",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "index.js" } },
  },
});
