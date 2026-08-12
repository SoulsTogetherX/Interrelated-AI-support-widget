"use client"

//#region Add-origin form
// Client for useActionState, like every mutation form. One field: the
// origin. Normalization happens server-side (lib/origins validateOrigin)
// and the success message echoes the normalized value, so a customer who
// pastes a full page URL learns what was actually allowlisted.
//#endregion

//#region Imports
import { useActionState } from "react"
import "./styles.css"

import { addOriginAction } from "@/lib/origins/actions"

import type { OriginFormState } from "@/lib/origins/actions"
//#endregion

//#region Component
const INITIAL: OriginFormState = { error: null, success: null }

export default function OriginForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState(addOriginAction, INITIAL)

  return (
    <form className="originform" action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <div className="originform-row">
        <label className="originform-label">
          Allowed origin
          {/* type=text, not type=url: the browser's url validation would
              reject a bare host BEFORE our validator can explain why a
              scheme is required. */}
          <input
            className="originform-input"
            name="origin"
            type="text"
            required
            placeholder="https://docs.example.com"
          />
        </label>
        <button className="originform-submit" type="submit" disabled={pending}>
          {pending ? "…" : "Allow"}
        </button>
      </div>
      {state.error ? (
        <p className="originform-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="originform-success" role="status">
          {state.success}
        </p>
      ) : null}
    </form>
  )
}
//#endregion
