//#region Imports
import { readFile } from "node:fs/promises"
import type { Express, Request, Response } from "express"
//#endregion

//#region Type Defs
/**
 * The public demo surface (M2.7): GET /demo, a page wearing the widget the
 * way a customer's site would, and GET /widget.js, the bundle itself —
 * this service is the widget's ORIGIN FALLBACK (the plan's distribution is
 * GitHub Release → jsDelivr, with us as origin), and the demo page is the
 * fallback's first consumer.
 *
 * publishableKey comes from DEMO_PUBLISHABLE_KEY at boot. Null is a legal,
 * honest state: /demo then renders setup instructions instead of a broken
 * widget, because a recruiter hitting a half-configured demo is the exact
 * "demo looks broken" failure the plan's risk table warns about — a page
 * that SAYS what it needs beats a bubble that silently errors.
 */
interface DemoRouteOptions {
  publishableKey: string | null
  /** Absolute path to the built widget bundle. In the prod image it is
   *  /app/widget/dist/widget.js (Dockerfile); dev serves the repo path. */
  widgetBundlePath: string
}
//#endregion

//#region Templates
/** pk values are public by design, but they pass through an attribute
 *  escape anyway — config is not user input, and this is still the cheap
 *  way to make that assumption unnecessary. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function demoPage(publishableKey: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interrelated — live demo</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: #1f2430; background: #fafafc; line-height: 1.6 }
  main { max-width: 680px; margin: 0 auto; padding: 56px 24px }
  h1 { font-size: 28px; margin-bottom: 4px }
  .sub { color: #667; margin-top: 0 }
  .card { background: #fff; border: 1px solid #e7e8ee; border-radius: 12px; padding: 20px 24px; margin-top: 24px }
  code { background: #f1f2f6; border-radius: 4px; padding: 1px 5px; font-size: 90% }
  .hint { color: #667; font-size: 14px }
</style>
</head>
<body>
<main>
  <h1>Interrelated</h1>
  <p class="sub">An embeddable AI support widget with verified citations.</p>
  <div class="card">
    <p>The bubble in the corner is indexed over the <b>Fastify documentation</b>.
    Every sentence it answers carries a citation, and every citation was
    verified by code: the quoted span must occur verbatim in the source
    chunk, or the claim is stripped before you see it.</p>
    <p>Try: <i>"How do I make Fastify listen on all interfaces?"</i> —
    then try <i>"What's a good recipe for banana bread?"</i> to see the
    groundedness gate refuse instead of improvising.</p>
    <p class="hint">This page consumes the same public snippet a customer
    would paste — one script tag, ~4 KB gzipped, Shadow DOM, no
    dependencies.</p>
  </div>
</main>
<script src="/widget.js" async
        data-key="${escapeAttr(publishableKey)}"
        data-api=""
        data-title="Fastify Docs Support"></script>
</body>
</html>`
}

/** data-api="" resolves fetch("" + "/v1/…") to the SAME ORIGIN the page
 *  was served from — the demo needs no absolute URL and works identically
 *  on localhost and Render. (ApiClient strips the trailing slash of a
 *  non-empty base; an empty base is already what we want.) */

const SETUP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Interrelated — demo not configured</title>
<style>body{font-family:system-ui;max-width:640px;margin:80px auto;padding:0 24px;color:#1f2430}code{background:#f1f2f6;padding:1px 5px;border-radius:4px}</style>
</head><body>
<h1>Interrelated</h1>
<p>The demo organization is not configured on this deployment yet. To turn it on:</p>
<ol>
<li>Seed the demo org against this deployment's database:
<code>npm run seed-demo -- --corpus fastify --origin &lt;this origin&gt;</code></li>
<li>Set <code>DEMO_PUBLISHABLE_KEY</code> to the printed key and redeploy.</li>
</ol>
<p>Health is live at <code>/api/health</code>; the widget bundle at <code>/widget.js</code>.</p>
</body></html>`
//#endregion

//#region Routes
function configureDemoRoutes(app: Express, options: DemoRouteOptions): void {
  app.get("/demo", (_req: Request, res: Response) => {
    res
      .type("html")
      .send(options.publishableKey !== null ? demoPage(options.publishableKey) : SETUP_PAGE)
  })

  app.get("/widget.js", async (_req: Request, res: Response) => {
    // Read per request, no in-memory cache: the file is ~8 KB, the prod
    // image is immutable, and a cache would go stale under the dev bind
    // mount — the boring option is also the correct one at this size.
    try {
      const bundle = await readFile(options.widgetBundlePath)
      res.type("application/javascript")
      // Short client cache: enough that one page visit fetches once, short
      // enough that a redeploy propagates in minutes without cache-busting.
      res.setHeader("cache-control", "public, max-age=300")
      res.send(bundle)
    } catch {
      res
        .status(404)
        .type("text/plain")
        .send("widget bundle not built (run `npm run build` in widget/)")
    }
  })
}
//#endregion

//#region Exports
export { configureDemoRoutes }
export type { DemoRouteOptions }
//#endregion
