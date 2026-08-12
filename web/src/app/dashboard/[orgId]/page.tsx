// The org overview — the org-scoped home every later surface (providers,
// sources, conversations, origins) hangs off. Access rule: requireOrgMember
// 404s non-members without revealing whether the org exists.
import Link from "next/link"

import { getPublishableKey, listOrgsForUser, requireOrgMember } from "@/lib/orgs"
import "./page.css"

export const metadata = { title: "Overview — Interrelated" }

export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { user, org } = await requireOrgMember(orgId)
  const [publishableKey, orgs] = await Promise.all([
    getPublishableKey(org.id),
    listOrgsForUser(user.id),
  ])
  const otherOrgs = orgs.filter((o) => o.id !== org.id)

  return (
    <div className="orghome">
      <header className="orghome-head">
        <div>
          <h1 className="orghome-name">{org.name}</h1>
          <p className="orghome-meta">
            {org.plan} plan · you are {org.role === "owner" ? "the owner" : "an agent"}
          </p>
        </div>
        <Link className="orghome-neworg" href="/dashboard/new">
          New organization
        </Link>
      </header>

      {otherOrgs.length > 0 ? (
        <nav className="orghome-switcher" aria-label="Your other organizations">
          Also yours:{" "}
          {otherOrgs.map((o) => (
            <Link key={o.id} href={`/dashboard/${o.id}`}>
              {o.name}
            </Link>
          ))}
        </nav>
      ) : null}

      <section className="orghome-card">
        <h2 className="orghome-cardtitle">Publishable key</h2>
        {/* The pk is PUBLIC by design (trust model: it identifies the org,
            authorizes nothing by itself — the origin allowlist and rate
            limits do the guarding), so showing it in full is correct. */}
        <code className="orghome-pk">{publishableKey ?? "no live key — rotation left this org keyless (unexpected)"}</code>
        <p className="orghome-cardnote">
          This value goes in your site&apos;s widget snippet. It is safe to be
          public: it only identifies this organization, and the widget refuses
          to serve origins you haven&apos;t allowlisted.
        </p>
      </section>

      <section className="orghome-card">
        <h2 className="orghome-cardtitle">Next steps</h2>
        <ol className="orghome-steps">
          <li>
            <strong>
              <Link href={`/dashboard/${org.id}/providers`}>
                Connect an AI provider
              </Link>
            </strong>{" "}
            — bring your own Groq, Gemini, Ollama, or OpenAI-compatible key.
          </li>
          <li>
            <strong>
              <Link href={`/dashboard/${org.id}/sources`}>
                Index your documentation
              </Link>
            </strong>{" "}
            — point a crawler at your docs site and watch it become
            citable.
          </li>
          <li>
            <strong>
              <Link href={`/dashboard/${org.id}/widget`}>
                Allowlist your site and copy the snippet
              </Link>
            </strong>{" "}
            — the two directives a strict CSP needs are on that page too.
          </li>
        </ol>
        <p className="orghome-cardnote">
          Every step above is live. Human handoff (M4) and usage metrics
          (M5) are what the dashboard still owes you.
        </p>
      </section>
    </div>
  )
}
