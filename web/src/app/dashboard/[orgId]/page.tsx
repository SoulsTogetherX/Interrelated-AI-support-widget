// The org overview — the org-scoped home every later surface (providers,
// sources, conversations, origins) hangs off. Access rule: requireOrgMember
// 404s non-members without revealing whether the org exists.
import Link from "next/link"

import RotateKeyForm from "@/components/RotateKeyForm"
import { ROTATION_GRACE_HOURS, listPublishableKeys } from "@/lib/keys"
import { revokePublishableKeyNowAction } from "@/lib/keys/actions"
import { listOrgsForUser, requireOrgMember } from "@/lib/orgs"
import { getTodayUsage } from "@/lib/usage/queries"
import "./page.css"

export const metadata = { title: "Overview — Interrelated" }

/** UTC to the minute — the dashboard's timestamp convention. */
function utcMinute(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ")
}

export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { user, org } = await requireOrgMember(orgId)
  const [keys, orgs, usage] = await Promise.all([
    listPublishableKeys(org.id),
    listOrgsForUser(user.id),
    getTodayUsage(org.id),
  ])
  const otherOrgs = orgs.filter((o) => o.id !== org.id)
  const isOwner = org.role === "owner"
  // Standing is decided in SQL against Postgres's clock (lib/keys), which is
  // the clock realtime's session route compares against — so what this page
  // calls "retiring" is exactly what the widget still accepts.
  const currentKey = keys.find((k) => k.status === "current") ?? null
  const retiringKeys = keys.filter((k) => k.status === "retiring")
  const revokedKeys = keys.filter((k) => k.status === "revoked")
  // The list is newest-CREATED first; the most recent REVOCATION can be an
  // older key whose window was ended early, so it is found, not assumed.
  const latestRevocation = revokedKeys.reduce<Date | null>(
    (latest, k) => (k.revokedAt && (!latest || k.revokedAt > latest) ? k.revokedAt : latest),
    null,
  )

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
        <code className="orghome-pk">
          {currentKey?.publishableKey ?? "no live key — this org has no current key (unexpected)"}
        </code>
        <p className="orghome-cardnote">
          This value goes in your site&apos;s widget snippet. It is safe to be
          public: it only identifies this organization, and the widget refuses
          to serve origins you haven&apos;t allowlisted.
        </p>
        {isOwner && currentKey ? (
          <RotateKeyForm orgId={org.id} keyId={currentKey.id} graceHours={ROTATION_GRACE_HOURS} />
        ) : null}

        {retiringKeys.length > 0 ? (
          <>
            <h3 className="orghome-subtitle">Retiring</h3>
            {/* Still accepted by the widget until the instant shown — that
                is what makes rotation safe to click: nothing breaks until the
                snippet has had time to change. last_used_at is stamped by
                every session mint, so "last used a minute ago" means the OLD
                snippet is still deployed somewhere. */}
            <ul className="orghome-keys">
              {retiringKeys.map((k) => (
                <li className="orghome-key" key={k.id}>
                  <div className="orghome-keymain">
                    <code className="orghome-keyvalue">{k.publishableKey}</code>
                    <span className="orghome-keymeta">
                      accepted until {k.revokedAt ? utcMinute(k.revokedAt) : "—"} UTC ·{" "}
                      {k.lastUsedAt ? `last used ${utcMinute(k.lastUsedAt)} UTC` : "not used since rotation"}
                    </span>
                  </div>
                  {isOwner ? (
                    <form action={revokePublishableKeyNowAction}>
                      <input type="hidden" name="orgId" value={org.id} />
                      <input type="hidden" name="keyId" value={k.id} />
                      <button className="orghome-revoke" type="submit">
                        Revoke now
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="orghome-cardnote">
              Revoking now stops new widget sessions on that key immediately; a
              visitor already chatting keeps their session (up to 30 minutes),
              because a session is bound to this organization, not to the key
              that opened it.
            </p>
          </>
        ) : null}

        {revokedKeys.length > 0 ? (
          <p className="orghome-cardnote">
            {revokedKeys.length === 1 ? "One earlier key" : `${revokedKeys.length} earlier keys`}{" "}
            revoked, most recently {latestRevocation ? `${utcMinute(latestRevocation)} UTC` : "—"}.
            A revoked key is refused exactly like one that never existed.
          </p>
        ) : null}
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
