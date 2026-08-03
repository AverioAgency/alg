import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["**/src/**/*.test.ts", "**/__tests__/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Contract tests hit fixtures, never live APIs; nothing here should need
    // a long timeout except the testcontainers-backed integration suites.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["**/dist/**", "**/*.config.ts", "**/migrations/**"],
    },
  },
  resolve: {
    alias: {
      "@alg/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@alg/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      "@alg/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@alg/adapters-signals": new URL("./packages/adapters/signals/src/index.ts", import.meta.url)
        .pathname,
      "@alg/adapters-discovery": new URL(
        "./packages/adapters/discovery/src/index.ts",
        import.meta.url
      ).pathname,
    },
  },
})
