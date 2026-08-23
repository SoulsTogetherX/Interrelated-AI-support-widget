"use client"

//#region Rotate-key form
// One button, one click — the plan's "one-click rotation" (trust-model
// layer 5). Client for useActionState like every mutation form, so the
// outcome renders inline: the new key appears in the card above through the
// revalidated page, and this form says what the OLD one is now doing.
//
// No confirmation step on purpose, for the reason M4.6's Close button has
// none: the click's consequence is bounded and stated beside it — the
// current key keeps working through the grace window, and "revoke now" is a
// separate control — so "are you sure?" would be ceremony over a decision
// the page has already explained. What DOES guard against an accidental
// double click is the hidden keyId: the action rotates FROM the key this
// page showed, and a second submit finds it already retiring and writes
// nothing (lib/keys/index.ts).
//#endregion

//#region Imports
import { useActionState } from "react"
import "./styles.css"

import { rotatePublishableKeyAction } from "@/lib/keys/actions"

import type { KeyFormState } from "@/lib/keys/actions"
//#endregion

//#region Component
const INITIAL: KeyFormState = { error: null, success: null }

export default function RotateKeyForm({
  orgId,
  keyId,
  graceHours,
}: {
  orgId: string
  /** The key the page rendered as current — what the rotation is FROM. */
  keyId: string
  graceHours: number
}) {
  const [state, formAction, pending] = useActionState(rotatePublishableKeyAction, INITIAL)

  return (
    <form className="rotatekey" action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="keyId" value={keyId} />
      <div className="rotatekey-row">
        <button className="rotatekey-submit" type="submit" disabled={pending}>
          {pending ? "…" : "Rotate key"}
        </button>
        <span className="rotatekey-hint">
          Issues a new key now. This one keeps working for {graceHours} hours so
          you can update your snippet without downtime.
        </span>
      </div>
      {state.error ? (
        <p className="rotatekey-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="rotatekey-success" role="status">
          {state.success}
        </p>
      ) : null}
    </form>
  )
}
//#endregion
