import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Unit tests run in Node (pure logic, no DOM). The `@` alias mirrors tsconfig so
// tests can import modules the same way the app does (e.g. "@/lib/providers").
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
});
