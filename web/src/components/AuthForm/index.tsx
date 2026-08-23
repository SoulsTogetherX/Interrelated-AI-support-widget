"use client"

//#region The one client component of M3.2
// Everything else renders on the server; this form needs useActionState for
// inline error display and a pending state, which is client territory. It is
// shared by login and signup — the two differ only in which action they
// submit to, their labels, and the password autocomplete hint (browsers use
// "new-password" to offer generation, "current-password" to offer fill).
//#endregion

//#region Imports
import { useActionState } from "react"
import "./styles.css"

import type { ReactNode } from "react"
import type { AuthFormState } from "@/lib/auth/actions"
//#endregion

//#region Types
interface AuthFormProps {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>
  title: string
  submitLabel: string
  passwordAutoComplete: "current-password" | "new-password"
  /** Rendered below the button — the "already have an account?" cross-link. */
  footer: ReactNode
}
//#endregion

//#region Component
export default function AuthForm({
  action,
  title,
  submitLabel,
  passwordAutoComplete,
  footer,
}: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, { error: null })

  return (
    <form className="authform" action={formAction}>
      <h1 className="authform-title">{title}</h1>
      <label className="authform-label">
        Email
        {/* maxLength mirrors validation.ts (254) — client hints, server
            decides; the real limits live in the validators. */}
        <input
          className="authform-input"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
        />
      </label>
      <label className="authform-label">
        Password
        <input
          className="authform-input"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
          minLength={8}
          maxLength={200}
        />
      </label>
      {state.error ? (
        <p className="authform-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="authform-submit" type="submit" disabled={pending}>
        {pending ? "One moment…" : submitLabel}
      </button>
      <p className="authform-footer">{footer}</p>
    </form>
  )
}
//#endregion
