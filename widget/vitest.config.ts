// Widget test runner — jsdom, because these tests assert real DOM behavior
// (shadow roots, event wiring, rendered text) without a browser. The
// fixture pages + a live browser cover what jsdom can't (CSS isolation,
// CSP); see widget/fixtures/.
import { defineConfig } from "vitest/config"

import { fileURLToPath } from "node:url"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "jsdom",
  },
  resolve: {
    alias: {
      // Mirrors tsconfig "paths". Needed only since M4.4: shared/ used to
      // contribute TYPE-ONLY imports, which are erased before anything has
      // to resolve them — the handoff protocol's typing constants are the
      // first VALUES the widget imports from it.
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
})
