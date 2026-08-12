//#region Styles
/**
 * The widget's entire stylesheet, as a string: applied via
 * adoptedStyleSheets (CSP-safe — constructed sheets are not inline style)
 * with a <style> fallback for engines without it (ui.ts).
 *
 * `:host { all: initial }` is the armor both ways: host styles can only
 * reach a shadow tree through INHERITED properties (font, color, custom
 * properties), and `all: initial` severs those — the fixture page with
 * `* { all: unset }` renders identically to a bare page. The one opening
 * left on purpose: --ir-accent pierces the boundary (custom properties
 * inherit) so a host can theme the bubble without any widget API.
 *
 * Sizes in px, not rem: rem resolves against the HOST page's root font
 * size, which is exactly the kind of leak `all: initial` exists to stop.
 */
const WIDGET_CSS = `
:host { all: initial }
* { box-sizing: border-box; margin: 0; padding: 0 }
.root {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.45; color: #1f2430;
  --accent: var(--ir-accent, #4f46e5);
}
.bubble {
  width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--accent); color: #fff; display: grid; place-items: center;
  box-shadow: 0 4px 14px rgba(0,0,0,.25); margin-left: auto;
}
.bubble:hover { filter: brightness(1.08) }
.bubble svg { width: 26px; height: 26px; fill: currentColor }
.panel {
  display: none; flex-direction: column; overflow: hidden;
  width: 360px; max-width: calc(100vw - 40px); height: 520px; max-height: calc(100vh - 96px);
  background: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.28);
  margin-bottom: 12px;
}
.root.open .panel { display: flex }
.head {
  background: var(--accent); color: #fff; padding: 12px 16px;
  display: flex; align-items: center; justify-content: space-between;
}
.head b { font-size: 15px; font-weight: 600 }
.head button {
  border: none; background: none; color: #fff; cursor: pointer; font-size: 18px;
  padding: 2px 6px; border-radius: 6px;
}
.head button:hover { background: rgba(255,255,255,.18) }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px }
.msg { max-width: 85%; padding: 9px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: break-word }
.msg.visitor { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px }
.msg.assistant { align-self: flex-start; background: #f1f2f6; border-bottom-left-radius: 4px }
.msg.notice { align-self: center; background: #fff7e6; color: #7a5b00; font-size: 13px; text-align: center }
.msg p + p { margin-top: 8px }
.cite { display: block; margin-top: 3px; font-size: 12px }
.cite a { color: var(--accent); text-decoration: none }
.cite a:hover { text-decoration: underline }
.typing { align-self: flex-start; color: #8a8f9e; font-size: 13px; padding: 2px 4px }
.foot { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e7e8ee }
.foot input {
  flex: 1; border: 1px solid #d4d6e0; border-radius: 9px; padding: 9px 12px;
  font: inherit; color: inherit; background: #fff; outline: none;
}
.foot input:focus { border-color: var(--accent) }
.foot button {
  border: none; border-radius: 9px; padding: 0 16px; cursor: pointer;
  background: var(--accent); color: #fff; font: inherit; font-weight: 600;
}
.foot button:disabled { opacity: .5; cursor: default }
`
//#endregion

//#region Exports
export { WIDGET_CSS }
//#endregion
