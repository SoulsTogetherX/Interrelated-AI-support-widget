//#region Imports
import { ApiClient } from "./api"
import { mountWidget } from "./ui"
//#endregion

//#region Captured globals
// Captured at script evaluation, BEFORE any host code that runs later can
// monkeypatch them — analytics and error-tracking snippets wrap
// window.fetch as a matter of course, and the widget must not route tenant
// traffic through whatever they installed. (Promise needs no capture: with
// an es2020 target, async functions use the engine's internal Promise, not
// window.Promise.)
const capturedFetch = window.fetch.bind(window)
//#endregion

//#region Boot
/**
 * The IIFE entry. Reads its configuration from the <script> tag itself:
 *
 *   <script src=".../widget.js" async
 *           data-key="pk_live_…"
 *           data-api="https://api.example.com"
 *           data-title="Acme Support"        (optional)
 *           data-accent="#0f766e">           (optional)
 *   </script>
 *
 * document.currentScript is live during initial evaluation (async
 * included), which is the only moment this code reads it. Configuration
 * errors log a warning and mount nothing — a broken snippet must degrade
 * to "no widget", never to a broken host page.
 */
function boot(): void {
  const script = document.currentScript
  if (!(script instanceof HTMLScriptElement)) return
  const key = script.dataset["key"]
  const api = script.dataset["api"]
  if (key === undefined || api === undefined) {
    console.warn("[interrelated] widget needs data-key and data-api on its <script> tag")
    return
  }
  // Two copies of the snippet must not produce two bubbles.
  if (document.getElementById("interrelated-widget") !== null) return

  const title = script.dataset["title"]
  const accent = script.dataset["accent"]
  const mount = (): void => {
    const host = document.createElement("div")
    host.id = "interrelated-widget"
    document.body.append(host)
    mountWidget(
      host,
      new ApiClient({ apiBase: api, publishableKey: key, fetchImpl: capturedFetch }),
      {
        ...(title !== undefined ? { title } : {}),
        ...(accent !== undefined ? { accent } : {}),
      },
    )
  }

  // <head> placement means body may not exist yet; interactive/complete
  // means it does. Either way the widget appears without the customer
  // caring where they pasted the snippet.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true })
  } else {
    mount()
  }
}

boot()
//#endregion
