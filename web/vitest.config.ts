// Web test runner. Environment is "node", not jsdom: the components under
// test are React Server Components — plain functions rendered with
// react-dom/server — so no DOM is involved. Client components arrive with
// the auth forms (M3.2) and will bring a jsdom environment pragma per file,
// the same pattern the widget package uses.
import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  // Vite's esbuild default is the CLASSIC JSX transform (React.createElement,
  // requiring React in scope) — Next's compiler uses the automatic runtime and
  // its components rightly never import React, so tests must match.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Same reasoning as realtime's config: DB-gated suites share one real
    // Postgres, and concurrent files mutating it flake in ways that look
    // like application bugs.
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
