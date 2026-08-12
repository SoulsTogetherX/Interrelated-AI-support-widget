// Provider settings: the BYO-key surface. The page tells the tenant exactly
// what happens to the key — pasted over TLS, tested against the real
// provider before anything persists, AES-GCM encrypted at rest on the
// realtime service, displayed only as a suffix forever after. Saying this
// ON the page is the product teaching its own trust model, same as the
// publishable-key card on the overview.
import Link from "next/link"

import ProviderForm from "@/components/ProviderForm"
import { requireOrgMember } from "@/lib/orgs"
import { listCredentialDisplay } from "@/lib/providers/queries"
import { removeProviderAction } from "@/lib/providers/actions"
import "./page.css"

export const metadata = { title: "Providers — Interrelated" }

export default async function ProvidersPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const credentials = await listCredentialDisplay(org.id)
  const generation = credentials.find((c) => c.role === "generation") ?? null
  const isOwner = org.role === "owner"

  return (
    <div className="providers">
      <nav className="providers-crumbs">
        <Link href={`/dashboard/${org.id}`}>{org.name}</Link> / Providers
      </nav>
      <h1 className="providers-title">AI provider</h1>
      <p className="providers-intro">
        Your organization brings its own AI provider. The key is tested with a
        real request before it is saved, stored encrypted (AES-256-GCM under a
        server-held master key), shown only as its last four characters from
        then on, and never returned by any API.
      </p>

      <section className="providers-card">
        <h2 className="providers-cardtitle">Generation</h2>
        {generation ? (
          <div className="providers-current">
            <p className="providers-currentline">
              <strong>{generation.provider}</strong>
              {generation.model ? ` · ${generation.model}` : " · provider default model"}
              {generation.suffix ? ` · key …${generation.suffix}` : " · no key (unauthenticated)"}
            </p>
            <p className="providers-validated">
              {generation.lastValidation
                ? `Last validated: ${generation.lastValidation}`
                : "Not validated yet"}
            </p>
            {isOwner ? (
              <form action={removeProviderAction}>
                <input type="hidden" name="orgId" value={org.id} />
                <button className="providers-remove" type="submit">
                  Remove credential
                </button>
              </form>
            ) : null}
          </div>
        ) : (
          <p className="providers-empty">No generation provider connected yet.</p>
        )}

        {isOwner ? (
          <ProviderForm orgId={org.id} />
        ) : (
          <p className="providers-agentnote">
            Only the organization owner can change provider settings.
          </p>
        )}
      </section>

      <section className="providers-card">
        <h2 className="providers-cardtitle">Embedding</h2>
        <p className="providers-empty">
          Embedding credentials arrive together with source indexing (M3.6) —
          until then, indexing runs on the platform&apos;s built-in embedding
          model.
        </p>
      </section>
    </div>
  )
}
