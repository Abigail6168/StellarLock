import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import prettierConfig from "eslint-config-prettier"

export default tseslint.config(
  // public/sw.js is a standalone service worker script with no benefit from
  // type-aware linting.
  { ignores: ["dist", "contracts", "public/sw.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.js",
            "vite.config.ts",
            "vitest.config.ts",
            "playwright.config.ts",
            "commitlint.config.js",
            ".storybook/*.ts",
            ".storybook/*.tsx",
            "api/*.ts",
            "api/_lib/*.ts",
            "api/notifications/*.ts",
            "indexer/*.ts",
            "e2e/*.ts",
            "e2e/pages/*.ts",
          ],
          // The globs above intentionally span more than the typescript-eslint
          // default cap of 8 files sharing the synthetic "default project".
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 30,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  prettierConfig,
)
