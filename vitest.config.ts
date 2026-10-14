import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"],
      // Floors for the code that guards the vault, a little under what the tests reach today.
      thresholds: {
        "src/background/**": { statements: 50, branches: 39, functions: 37, lines: 51 },
        "src/shared/**": { statements: 74, branches: 70, functions: 76, lines: 74 },
      },
    },
  },
});
