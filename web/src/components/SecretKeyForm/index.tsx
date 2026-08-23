"use client"

//#region Secret-key form
// Issue-or-rotate for the SECRET key (trust-model layer 6, M7.3), and the
// one place the plaintext is ever shown. Client for useActionState like every
// mutation form — but here the client state is load-bearing rather than
// cosmetic: the action returns the key's value exactly once, the row holds
// only its hash, and this component's state is where the value lives until
// the owner has copied it or navigated away. That is why the component is
// ONE form for both states ("no key yet" → Generate, "a current key" →
// Rotate) and stays mounted at the same place in the card across the change:
// a component that unmounted when the page went from no-key to key would take
// the just-issued value with it.
//
// The reveal is tied to the key it belongs to: the action returns the row id
// with the value, and the box renders only while the page's current key IS
// that row. Rotate again and the box shows the newer value; revoke it and the
// box goes away rather than displaying a key that no longer works.
//
// No confirmation step, for RotateKeyForm's reason: the consequence is
// bounded and stated beside the button (the current key keeps working
// through the grace window; "revoke" is a separate control), and the hidden
// keyId makes a double click a no-op rather than a second rotation.
//#endregion

//#region Imports
import { useActionState } from "react"
import "./styles.css"

import CopyButton from "@/components/CopyButton"
import { secretKeyAction } from "@/lib/keys/actions"

import type { SecretKeyFormState } from "@/lib/keys/actions"
//#endregion

//#region Component
const INITIAL: SecretKeyFormState = { error: null, success: null, secretKey: null, keyId: null }

export default function SecretKeyForm({
  orgId,
  currentKeyId,
  graceHours,
}: {
  orgId: string
  /** The page's current secret key, or null when the org has none — which
   *  decides whether this form issues or rotates. */
  currentKeyId: string | null
  graceHours: number
}) {
  const [state, formAction, pending] = useActionState(secretKeyAction, INITIAL)
  const reveal = state.secretKey !== null && state.keyId !== null && state.keyId === currentKeyId

  return (
    <form className="secretkey" action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="keyId" value={currentKeyId ?? ""} />
      <div className="secretkey-row">
        <button className="secretkey-submit" type="submit" disabled={pending}>
          {pending ? "…" : currentKeyId === null ? "Generate secret key" : "Rotate secret key"}
        </button>
        <span className="secretkey-hint">
          {currentKeyId === null
            ? "Issues a key for your server to mint widget sessions with. Shown once; store it as a server secret."
            : `Issues a new key now. The current one keeps working for ${graceHours} hours so you can redeploy without downtime.`}
        </span>
      </div>
      {state.error ? (
        <p className="secretkey-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {reveal ? (
        <div className="secretkey-reveal" role="status">
          <p className="secretkey-revealnote">{state.success}</p>
          <code className="secretkey-value">{state.secretKey}</code>
          <CopyButton text={state.secretKey ?? ""} label="Copy secret key" />
        </div>
      ) : null}
    </form>
  )
}
//#endregion
