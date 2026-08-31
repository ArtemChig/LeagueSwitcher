import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Renderer build only. The main and preload processes are bundled by
 * scripts/build-electron.mjs with esbuild instead of electron-vite, because electron-vite
 * pins vite@7 while vitest@4 requires vite@8 — and the test runner is not worth downgrading
 * for a build wrapper this thin.
 */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./", // loaded over file:// in the packaged app
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome130",
  },
  server: { port: 5273, strictPort: true },
});
