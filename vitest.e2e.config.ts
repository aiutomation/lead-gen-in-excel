import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Separate config so E2E tests are NEVER part of `vitest run` (the unit suite that
// gates the build). These hit a live server + real LLM; run only via `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000, // real LLM round-trip + possible free-instance cold start
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
});
