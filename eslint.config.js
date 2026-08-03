// @ts-check
import js from "@eslint/js"
import tseslint from "typescript-eslint"
import noRawDrizzle from "./tools/eslint-rules/no-raw-drizzle-query.js"

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/drizzle/**", "**/migrations/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Discourage type assertions. `as const` is exempt: it narrows a literal
      // rather than overriding the checker, which is the thing worth flagging.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > TSTypeReference > Identifier[name!='const']:not([name='unknown'])",
          message:
            "Avoid `as` casts. If unavoidable, disable this rule inline with a comment explaining why.",
        },
      ],
    },
  },
  // packages/shared is consumed by the frontend: it must never import server-only modules.
  // Its own tests are exempt - no-server-imports.test.ts has to read the source tree
  // from disk in order to check exactly this, and tests are never bundled.
  {
    files: ["packages/shared/**/*.ts"],
    ignores: ["packages/shared/**/*.test.ts", "packages/shared/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "fs",
                "path",
                "crypto",
                "child_process",
                "drizzle-orm",
                "drizzle-orm/*",
                "pg",
                "postgres",
                "bullmq",
                "ioredis",
                "express",
                "pino",
                "@alg/db",
                "@alg/core",
              ],
              message:
                "@alg/shared is imported by the frontend and must stay free of server-only dependencies.",
            },
          ],
        },
      ],
    },
  },
  // Custom rule: every Drizzle query must go through withWorkspace().
  {
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    ignores: ["**/*.test.ts", "packages/db/src/workspace.ts", "packages/db/src/client.ts"],
    plugins: {
      alg: { rules: { "no-raw-drizzle-query": noRawDrizzle } },
    },
    rules: {
      "alg/no-raw-drizzle-query": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/__tests__/**/*.ts", "tools/**/*.js", "infra/scripts/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": "off",
    },
  }
)
