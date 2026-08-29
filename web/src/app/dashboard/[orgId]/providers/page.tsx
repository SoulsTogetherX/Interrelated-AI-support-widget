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

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
export default async function ProvidersPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const credentials = await listCredentialDisplay(org.id)
  const generation = credentials.find((c) => c.role === "generation") ?? null
  const embedding = credentials.find((c) => c.role === "embedding") ?? null
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
                <input type="hidden" name="role" value="generation" />
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
          <ProviderForm orgId={org.id} role="generation" />
        ) : (
          <p className="providers-agentnote">
            Only the organization owner can change provider settings.
          </p>
        )}
      </section>

      <section className="providers-card">
        <h2 className="providers-cardtitle">Embedding</h2>
        <p className="providers-cardintro">
          Embeddings turn your pages — and every visitor question — into
          vectors. Both sides must come from the same model, so changing this
          re-indexes your sources automatically; until that finishes, answers
          come from the pages already indexed under the new model. Connect
          nothing and indexing runs on the platform&apos;s built-in model.
        </p>
        {embedding ? (
          <div className="providers-current">
            <p className="providers-currentline">
              <strong>{embedding.provider}</strong>
              {embedding.model ? ` · ${embedding.model}` : " · provider default model"}
              {embedding.dim ? ` · ${embedding.dim} dimensions` : ""}
              {embedding.suffix ? ` · key …${embedding.suffix}` : " · no key (unauthenticated)"}
            </p>
            <p className="providers-validated">
              {embedding.lastValidation
                ? `Last validated: ${embedding.lastValidation}`
                : "Not validated yet"}
            </p>
            {isOwner ? (
              <form action={removeProviderAction}>
                <input type="hidden" name="orgId" value={org.id} />
                <input type="hidden" name="role" value="embedding" />
                <button className="providers-remove" type="submit">
                  Remove credential
                </button>
              </form>
            ) : null}
          </div>
        ) : (
          <p className="providers-empty">No embedding provider connected yet.</p>
        )}

        {isOwner ? (
          <ProviderForm orgId={org.id} role="embedding" />
        ) : (
          <p className="providers-agentnote">
            Only the organization owner can change provider settings.
          </p>
        )}
      </section>
    </div>
  )
}
