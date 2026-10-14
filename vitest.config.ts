import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["test/**/*.test.ts", "e2e/firefox/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"],
      // Floors for the code that guards the vault, a little under what the tests reach today.
      thresholds: {
        "src/background/**": { statements: 90, branches: 83, functions: 89, lines: 91 },
        "src/shared/**": { statements: 96, branches: 92, functions: 95, lines: 96 },
        "src/content/**": { statements: 96, branches: 91, functions: 95, lines: 96 },
        "src/popup/**": { statements: 95, branches: 88, functions: 96, lines: 94 },
        "src/options/**": { statements: 98, branches: 95, functions: 99, lines: 98 },
      },
    },
  },
});
