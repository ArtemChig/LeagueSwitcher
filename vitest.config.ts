import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts on purpose: that one roots at src/renderer to build the
 * renderer bundle, and vitest would otherwise inherit that root and find no tests at all.
 */
export default defineConfig({
  test: {
    root: __dirname,
    include: ["tests/**/*.test.ts"],
    // The vault tests call real DPAPI and scrypt, which are deliberately slow.
    testTimeout: 30_000,
  },
});
