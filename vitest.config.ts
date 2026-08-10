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
    include: ["shared/**/*.test.ts"],
    environment: "node",
  },
})
