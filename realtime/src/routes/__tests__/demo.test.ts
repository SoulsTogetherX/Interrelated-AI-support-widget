//#region Imports
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createApp } from "@/app"
//#endregion

//#region Test Setup
// The demo surface is static config → static responses: fully testable
// keylessly and DB-free (createApp mounts demo without widget deps).
let dir: string
let bundlePath: string
let server: Server
let baseUrl: string

async function listen(publishableKey: string | null): Promise<void> {
  const app = createApp({ demo: { publishableKey, widgetBundlePath: bundlePath } })
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  baseUrl = `http://127.0.0.1:${address.port}`
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "demo-route-"))
  bundlePath = join(dir, "widget.js")
  writeFileSync(bundlePath, "(()=>{/* fake bundle */})()")
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
//#endregion

describe("demo routes", () => {
  it("serves the demo page wearing the snippet when a key is configured", async () => {
    await listen("pk_demo_key")
    try {
      const response = await fetch(`${baseUrl}/demo`)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('data-key="pk_demo_key"')
      expect(html).toContain('src="/widget.js"')
      // Same-origin API base: the demo must work on any deployment origin
      // without configuration.
      expect(html).toContain('data-api=""')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("serves honest setup instructions when no key is configured", async () => {
    await listen(null)
    try {
      const response = await fetch(`${baseUrl}/demo`)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain("not configured")
      expect(html).toContain("DEMO_PUBLISHABLE_KEY")
      expect(html).not.toContain("data-key")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("escapes a hostile key rather than letting it into markup", async () => {
    await listen('pk_"><script>alert(1)</script>')
    try {
      const html = await (await fetch(`${baseUrl}/demo`)).text()
      expect(html).not.toContain("<script>alert(1)")
      expect(html).toContain("&quot;&gt;&lt;script&gt;")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("serves the bundle with a JS content type and a short cache", async () => {
    await listen("pk_demo_key")
    try {
      const response = await fetch(`${baseUrl}/widget.js`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("javascript")
      expect(response.headers.get("cache-control")).toBe("public, max-age=300")
      expect(await response.text()).toContain("fake bundle")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("404s with a build hint when the bundle is missing", async () => {
    const missing = join(dir, "nope.js")
    const app = createApp({ demo: { publishableKey: "pk_x", widgetBundlePath: missing } })
    const local = createServer(app)
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve))
    const address = local.address()
    if (address === null || typeof address === "string") throw new Error("no port")
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/widget.js`)
      expect(response.status).toBe(404)
      expect(await response.text()).toContain("npm run build")
    } finally {
      await new Promise((resolve) => local.close(resolve))
    }
  })
})
