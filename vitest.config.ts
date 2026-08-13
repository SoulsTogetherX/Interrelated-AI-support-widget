// Root vitest config — runs ONLY the shared/ tests.
//
// Each application package (realtime/, later web/ and widget/) carries its own
// vitest config and its own test run, because each needs a different
// environment (node vs jsdom) and different aliases. The root config exists so
// shared/ — which has no package.json — still has a test runner. Deliberately
// no path aliases here: shared/ imports itself relatively, which is what keeps
// it importable from every package without a build step.
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // shared/, providers/, eval/, AND loadtest/ — alias-joined source
    // folders with no package.json of their own, so the root runner owns
    // their tests. (loadtest's socket scenario needs a running service and
    // is not a unit test; what IS unit-tested here is the histogram whose
    // percentiles end up in the README.)
    include: [
      "shared/**/*.test.ts",
      "providers/**/*.test.ts",
      "eval/**/*.test.ts",
      "loadtest/**/*.test.ts",
    ],
    environment: "node",
  },
})
