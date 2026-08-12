// Widget test runner — jsdom, because these tests assert real DOM behavior
// (shadow roots, event wiring, rendered text) without a browser. The
// fixture pages + a live browser cover what jsdom can't (CSS isolation,
// CSP); see widget/fixtures/.
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "jsdom",
  },
})
