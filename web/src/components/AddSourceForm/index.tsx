"use client"

//#region Add-source form
// Client for useActionState, like every mutation form. Depth only applies
// to crawl (url) sources — a sitemap already enumerates its pages — so the
// field hides for sitemaps; the server ignores depth it doesn't need.
//#endregion

//#region Imports
import { useActionState, useState } from "react"
import "./styles.css"

import { addSourceAction } from "@/lib/sources/actions"

import type { SourceFormState } from "@/lib/sources/actions"
//#endregion

//#region Component
const INITIAL: SourceFormState = { error: null, success: null }

export default function AddSourceForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState(addSourceAction, INITIAL)
  const [kind, setKind] = useState<"url" | "sitemap">("url")

  return (
    <form className="addsource" action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <div className="addsource-row">
        <label className="addsource-label addsource-kind">
          Type
          <select
            className="addsource-input"
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as "url" | "sitemap")}
          >
            <option value="url">Crawl a site</option>
            <option value="sitemap">Sitemap</option>
          </select>
        </label>
        <label className="addsource-label addsource-location">
          {kind === "sitemap" ? "Sitemap URL" : "Start URL"}
          <input
            className="addsource-input"
            name="location"
            type="url"
            required
            placeholder={
              kind === "sitemap"
                ? "https://docs.example.com/sitemap.xml"
                : "https://docs.example.com/"
            }
          />
        </label>
        {kind === "url" ? (
          <label className="addsource-label addsource-depth">
            Depth
            <select className="addsource-input" name="crawlDepth" defaultValue="">
              <option value="">default</option>
              <option value="0">0 — just this page</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </label>
        ) : null}
        <button className="addsource-submit" type="submit" disabled={pending}>
          {pending ? "…" : "Connect"}
        </button>
      </div>
      {state.error ? (
        <p className="addsource-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="addsource-success" role="status">
          {state.success}
        </p>
      ) : null}
    </form>
  )
}
//#endregion
