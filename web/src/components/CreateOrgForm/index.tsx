"use client"

//#region Why a client component
// Same reason as AuthForm: useActionState for inline errors and a pending
// state. The form itself is one field — the org name — because onboarding
// should cost one decision; provider keys, sources, and origins each have
// their own dashboard surface (M3.4–M3.8) with room to explain themselves.
//#endregion

//#region Imports
import { useActionState } from "react"
import "./styles.css"

import { createOrgAction } from "@/lib/orgs/actions"
//#endregion

//#region Component
export default function CreateOrgForm({ title }: { title: string }) {
  const [state, formAction, pending] = useActionState(createOrgAction, {
    error: null,
  })

  return (
    <form className="createorg" action={formAction}>
      <h1 className="createorg-title">{title}</h1>
      <p className="createorg-hint">
        An organization owns everything else: your documentation sources, the
        AI provider key, the widget, and its conversations.
      </p>
      <label className="createorg-label">
        Organization name
        <input
          className="createorg-input"
          name="name"
          type="text"
          autoComplete="organization"
          required
          minLength={2}
          maxLength={64}
        />
      </label>
      {state.error ? (
        <p className="createorg-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="createorg-submit" type="submit" disabled={pending}>
        {pending ? "One moment…" : "Create organization"}
      </button>
    </form>
  )
}
//#endregion
