"use client"

//#region Upload-source form
// The other half of AddSourceForm (M7.6b): a source the tenant HANDS OVER
// rather than one the crawler goes and gets. Client for useActionState, like
// every mutation form here.
//
// Two things this form does that the crawl form does not, both because a
// file is not a URL:
//
//   * It checks the size before sending. Next caps a Server Action request
//     (next.config.ts) and realtime caps the upload, and neither of those
//     limits can produce a good message from inside the browser — the first
//     fails the request before the action runs, the second after 10 MB has
//     crossed the wire. Refusing here is instant and says the same number.
//   * It names the file it is about to send, because `<input type="file">`
//     renders differently in every browser and a tenant who picked the wrong
//     document should see that before they wait for it to index.
//#endregion

//#region Imports
import { useActionState, useRef, useState } from "react"
import "./styles.css"

import { uploadSourceAction } from "@/lib/sources/actions"

import type { SourceFormState } from "@/lib/sources/actions"
//#endregion

//#region Component
const INITIAL: SourceFormState = { error: null, success: null }

/** Realtime's cap, repeated here as the number the browser can enforce
 *  before spending the upload. The service enforces it again regardless —
 *  this form is convenience, not a control. */
const MAX_MB = 10
const MAX_BYTES = MAX_MB * 1024 * 1024

export default function UploadSourceForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState(uploadSourceAction, INITIAL)
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null)
  const [tooBig, setTooBig] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <form className="uploadsource" action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <div className="uploadsource-row">
        <label className="uploadsource-label">
          File
          <input
            ref={inputRef}
            className="uploadsource-input"
            name="file"
            type="file"
            required
            accept=".pdf,.md,.markdown,.html,.htm,.txt,application/pdf,text/markdown,text/html,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null
              setChosen(file ? { name: file.name, size: file.size } : null)
              setTooBig(file ? file.size > MAX_BYTES : false)
            }}
          />
        </label>
        <button
          className="uploadsource-submit"
          type="submit"
          disabled={pending || tooBig || !chosen}
        >
          {pending ? "Reading…" : "Upload"}
        </button>
      </div>
      {chosen && !tooBig ? (
        <p className="uploadsource-chosen">
          {chosen.name} — {formatSize(chosen.size)}
        </p>
      ) : null}
      {tooBig ? (
        <p className="uploadsource-error" role="alert">
          {chosen?.name} is {formatSize(chosen?.size ?? 0)} — the limit is {MAX_MB} MB.
        </p>
      ) : null}
      {state.error ? (
        <p className="uploadsource-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="uploadsource-success" role="status">
          {state.success}
        </p>
      ) : null}
    </form>
  )
}

/** Bytes as the tenant would write them. Binary units, because that is what
 *  the cap is measured in — showing 10.4 MB for a file the server calls
 *  oversized would read as a bug. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
//#endregion
