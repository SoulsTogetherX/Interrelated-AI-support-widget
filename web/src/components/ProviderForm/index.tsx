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
// Per ROLE, because the two are genuinely different sets: neither Groq nor
// Anthropic has an embeddings endpoint at all, and the model defaults
// differ even where the provider is the same (gemini-3.6-flash generates,
// gemini-embedding-001 embeds). Both facts are enforced server-side in
// checkCredentialInput — listed here so the form does not offer a
// combination that cannot work.
const PROVIDERS = {
  generation: [
    { value: "groq", label: "Groq", needsKey: true, needsBase: false, modelHint: "llama-3.3-70b-versatile (default)" },
    { value: "gemini", label: "Google Gemini", needsKey: true, needsBase: false, modelHint: "gemini-3.6-flash (default)" },
    // Listed last of the hosted providers on purpose: it is the only one
    // with no free tier, so it is the only one where clicking Test spends
    // money. The label says so rather than leaving a tenant to find out.
    { value: "anthropic", label: "Anthropic Claude (paid)", needsKey: true, needsBase: false, modelHint: "claude-haiku-4-5-20251001 (default)" },
    { value: "ollama", label: "Ollama (self-hosted)", needsKey: false, needsBase: true, modelHint: "required — a model you have pulled" },
    { value: "openai_compatible", label: "OpenAI-compatible", needsKey: true, needsBase: true, modelHint: "required" },
  ],
  embedding: [
    { value: "gemini", label: "Google Gemini", needsKey: true, needsBase: false, modelHint: "gemini-embedding-001 (default)" },
    { value: "ollama", label: "Ollama (self-hosted)", needsKey: false, needsBase: true, modelHint: "required — e.g. nomic-embed-text" },
    { value: "openai_compatible", label: "OpenAI-compatible", needsKey: true, needsBase: true, modelHint: "required — up to 1024 dimensions" },
  ],
} as const

type Role = keyof typeof PROVIDERS
type ProviderValue = (typeof PROVIDERS)[Role][number]["value"]
//#endregion

//#region Component
const INITIAL: ProviderFormState = { error: null, success: null }

export default function ProviderForm({ orgId, role = "generation" }: { orgId: string; role?: Role }) {
  const [state, formAction, pending] = useActionState(submitProviderAction, INITIAL)
  const choices = PROVIDERS[role]
  const [provider, setProvider] = useState<ProviderValue>(choices[0].value)
  const meta = choices.find((p) => p.value === provider) ?? choices[0]

  return (
    <form className="providerform" action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="role" value={role} />

      <label className="providerform-label">
        Provider
        <select
          className="providerform-input"
          name="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as ProviderValue)}
        >
          {choices.map((p) => (
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
