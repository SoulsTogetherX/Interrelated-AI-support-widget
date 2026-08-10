// Realtime test runner.
//
// fileParallelism is OFF because the integration tests share one real
// Postgres database; two files migrating and truncating the same schema
// concurrently would flake in ways that look like application bugs.
// Unit tests lose a little speed; determinism wins.
import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Mirrors tsconfig "paths" — vitest resolves through its own bundler
      // and does not read tsconfig aliases on its own.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
})
