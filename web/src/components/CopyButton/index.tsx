"use client"

//#region Copy-to-clipboard
// The snippet is the one thing on the dashboard a customer MUST transfer
// somewhere else, so it gets a real copy button rather than "select this
// text". Degrades honestly: where the Clipboard API is unavailable
// (non-secure context, older browser, denied permission) the button says
// so instead of silently doing nothing — the text is still selectable
// above it.
//#endregion

//#region Imports
import { useState } from "react"
import "./styles.css"
//#endregion

//#region Component
export default function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setStatus("copied")
    } catch {
      setStatus("failed")
    }
    // Back to idle so the button is honest about the NEXT click rather
    // than showing a stale "copied" forever.
    setTimeout(() => setStatus("idle"), 2500)
  }

  return (
    <button className="copybtn" type="button" onClick={copy}>
      {status === "copied" ? "Copied" : status === "failed" ? "Copy failed — select it" : label}
    </button>
  )
}
//#endregion
