"use client"

//#region The provider setup form
// Client component for the same reason as the auth forms (useActionState),
// plus one piece of real client state: the chosen provider decides which
// fields exist. Field VISIBILITY is UX; field REQUIREMENTS are enforced
// server-side in realtime's checkCredentialInput — this form never
// duplicates that logic, it just avoids asking for what a provider cannot
// take (an Ollama key, a Groq base URL).
//
// The key input is type=password with autocomplete=off: it should look like
// what it is — a secret being handed over — and never linger in autofill.
//#endregion

//#region Imports
import { useActionState, useState } from "react"
import "./styles.css"

import { submitProviderAction } from "@/lib/providers/actions"

import type { ProviderFormState } from "@/lib/providers/actions"
//#endregion

//#region Provider field matrix
const PROVIDERS = [
  { value: "groq", label: "Groq", needsKey: true, needsBase: false, modelHint: "llama-3.3-70b-versatile (default)" },
  { value: "gemini", label: "Google Gemini", needsKey: true, needsBase: false, modelHint: "gemini-2.5-flash (default)" },
  { value: "ollama", label: "Ollama (self-hosted)", needsKey: false, needsBase: true, modelHint: "required — a model you have pulled" },
  { value: "openai_compatible", label: "OpenAI-compatible", needsKey: true, needsBase: true, modelHint: "required" },
] as const

type ProviderValue = (typeof PROVIDERS)[number]["value"]
//#endregion

//#region Component
const INITIAL: ProviderFormState = { error: null, success: null }

export default function ProviderForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState(submitProviderAction, INITIAL)
  const [provider, setProvider] = useState<ProviderValue>("groq")
  const meta = PROVIDERS.find((p) => p.value === provider)!

  return (
    <form className="providerform" action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />

      <label className="providerform-label">
        Provider
        <select
          className="providerform-input"
          name="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as ProviderValue)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {meta.needsKey ? (
        <label className="providerform-label">
          API key
          <input
            className="providerform-input"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder="pasted once, encrypted at rest, never shown again"
          />
        </label>
      ) : null}

      {meta.needsBase ? (
        <label className="providerform-label">
          Base URL
          <input
            className="providerform-input"
            name="baseUrl"
            type="url"
            placeholder="https://…  (must be publicly reachable)"
          />
        </label>
      ) : null}

      <label className="providerform-label">
        Model
        <input className="providerform-input" name="model" type="text" placeholder={meta.modelHint} />
      </label>

      {state.error ? (
        <p className="providerform-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="providerform-success" role="status">
          {state.success}
        </p>
      ) : null}

      <div className="providerform-buttons">
        {/* Test and Save are ONE server path (save flag) — the buttons only
            choose whether the validated round-trip persists. */}
        <button
          className="providerform-test"
          type="submit"
          name="intent"
          value="test"
          disabled={pending}
        >
          {pending ? "…" : "Test"}
        </button>
        <button
          className="providerform-save"
          type="submit"
          name="intent"
          value="save"
          disabled={pending}
        >
          {pending ? "…" : "Test & save"}
        </button>
      </div>
    </form>
  )
}
//#endregion
