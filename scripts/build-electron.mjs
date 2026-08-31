/**
 * Bundle the Electron main and preload processes.
 *
 * Main ships as ESM (Electron 44 supports it) so it shares the source's import style.
 * Preload ships as CJS: a preload script runs before the renderer's module system exists,
 * and CJS is what works reliably there.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist/main", { recursive: true, force: true });
rmSync("dist/preload", { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  // Electron and Node builtins stay external — they are provided by the runtime.
  external: ["electron"],
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.mjs",
  format: "esm",
  // esbuild leaves these ESM-only globals undefined when bundling; the main process uses
  // fileURLToPath(import.meta.url) to find its own directory, so they must survive.
  banner: { js: "" },
});

await build({
  ...shared,
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload/index.cjs",
  format: "cjs",
});

if (!watch) console.log("main + preload bundled");
