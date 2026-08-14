// The org overview — the org-scoped home every later surface (providers,
// sources, conversations, origins) hangs off. Access rule: requireOrgMember
// 404s non-members without revealing whether the org exists.
import Link from "next/link"

import { getPublishableKey, listOrgsForUser, requireOrgMember } from "@/lib/orgs"
import { getTodayUsage } from "@/lib/usage/queries"
import "./page.css"

export const metadata = { title: "Overview — Interrelated" }

export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { user, org } = await requireOrgMember(orgId)
  const [publishableKey, orgs, usage] = await Promise.all([
    getPublishableKey(org.id),
    listOrgsForUser(user.id),
    getTodayUsage(org.id),
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

      {usage ? (
        <section className="orghome-card">
          <h2 className="orghome-cardtitle">Today</h2>
          {/* The same counter realtime reads before every model call, shown
              here so the ceiling is never a surprise — the plan's promise
              is that the worst case is a stopped widget, not a bill. */}
          <p className="orghome-usage">
            <strong>{usage.answers.toLocaleString("en-US")}</strong> of{" "}
            {usage.limit.toLocaleString("en-US")} answers today
            {usage.refusals > 0 ? ` · ${usage.refusals} refused for want of evidence` : null}
            {usage.escalations > 0 ? ` · ${usage.escalations} reached a person` : null}
          </p>
          <div
            className="orghome-meter"
            role="meter"
            aria-valuenow={usage.answers}
            aria-valuemin={0}
            aria-valuemax={usage.limit}
            aria-label="Answers used today"
          >
            <span className="orghome-meterfill" style={{ width: `${usage.fraction * 100}%` }} />
          </div>
          <p className="orghome-cardnote">
            {usage.plan.name} allows {usage.limit.toLocaleString("en-US")} answers per UTC day,
            counted per organization and checked before the model is called — a refusal counts
            too, because it still costs a retrieval. The count resets at midnight UTC.
          </p>
        </section>
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
          Every step above is live, as are the{" "}
          <Link href={`/dashboard/${org.id}/inbox`}>agent inbox</Link>,{" "}
          <Link href={`/dashboard/${org.id}/metrics`}>metrics</Link>, and{" "}
          <Link href={`/dashboard/${org.id}/billing`}>billing</Link>.
        </p>
      </section>
    </div>
  )
}
