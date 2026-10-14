// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".output/", ".wxt/", "node_modules/", "coverage/", "e2e/test-results/", "e2e/playwright-report/", "e2e/.quark/"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Playwright reads a fixture's dependencies from its first parameter, which
    // has to be a destructuring pattern even when it needs none: `async ({}, use)`.
    files: ["e2e/**/*.ts"],
    rules: { "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }] },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
