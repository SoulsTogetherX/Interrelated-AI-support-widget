// The org overview — the org-scoped home every later surface (providers,
// sources, conversations, origins) hangs off. Access rule: requireOrgMember
// 404s non-members without revealing whether the org exists.
import Link from "next/link"

import RotateKeyForm from "@/components/RotateKeyForm"
import SecretKeyForm from "@/components/SecretKeyForm"
import { ROTATION_GRACE_HOURS, listPublishableKeys, listSecretKeys } from "@/lib/keys"
import { revokePublishableKeyNowAction, revokeSecretKeyNowAction } from "@/lib/keys/actions"
import { listOrgsForUser, requireOrgMember } from "@/lib/orgs"
import { refusedSummary } from "@/lib/traffic/queries"
import { getTodayUsage } from "@/lib/usage/queries"
import "./page.css"

const TRAFFIC_DAYS = 7

export const metadata = { title: "Overview — Interrelated" }

/** UTC to the minute — the dashboard's timestamp convention. */
function utcMinute(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ")
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { user, org } = await requireOrgMember(orgId)
  const [keys, secretKeys, orgs, usage, refused] = await Promise.all([
    listPublishableKeys(org.id),
    listSecretKeys(org.id),
    listOrgsForUser(user.id),
    getTodayUsage(org.id),
    refusedSummary(org.id, TRAFFIC_DAYS),
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
  // The secret key (layer 6, §9.19): same standing rule, same clock. Most
  // orgs have none — server-side sessions are optional — and the card says
  // what having one buys before offering to issue it.
  const currentSecret = secretKeys.find((k) => k.status === "current") ?? null
  const retiringSecrets = secretKeys.filter((k) => k.status === "retiring")
  const revokedSecrets = secretKeys.filter((k) => k.status === "revoked")

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

      {refused.refused > 0 ? (
        /* Layer 4's flag (§9.18). Only when there is something to flag: a
           quiet week renders nothing, not a reassurance nobody asked for.
           The allowlist already refused every one of these — this is
           visibility, and the Install page is where it can be acted on. */
        <p className="orghome-flag" role="status">
          <strong>{refused.refused.toLocaleString("en-US")}</strong> widget{" "}
          {refused.refused === 1 ? "load was" : "loads were"} refused from{" "}
          {refused.origins === 1 ? "an origin" : `${refused.origins} origins`} you have not
          allowlisted in the last {TRAFFIC_DAYS} days. If one is your own site, allow it; if
          not, someone has a copy of your snippet and the allowlist is doing its job.{" "}
          <Link href={`/dashboard/${org.id}/widget`}>See which origins</Link>
        </p>
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
        <h2 className="orghome-cardtitle">Secret key — server-side sessions</h2>
        {/* Layer 6 (§9.19). The value is never on this page except in the
            moment it is issued: the row holds a hash and these four
            characters. Optional by design — most orgs run on the publishable
            key alone, and the card says what the secret one buys. */}
        <p className="orghome-cardnote orghome-cardnote--lead">
          Optional. With a secret key, <em>your</em> server mints widget sessions for users it has
          signed in, and your page carries no publishable key at all — nothing worth copying, and
          only your logged-in users can open a chat. The recipe is on the{" "}
          <Link href={`/dashboard/${org.id}/widget`}>Install page</Link>. Never put this key in a
          page or a snippet: it belongs in your server&apos;s configuration.
        </p>
        {currentSecret ? (
          <p className="orghome-secret">
            <code className="orghome-keyvalue">sk_live_…{currentSecret.suffix}</code>
            <span className="orghome-keymeta">
              {" "}issued {utcMinute(currentSecret.createdAt)} UTC ·{" "}
              {currentSecret.lastUsedAt
                ? `last used ${utcMinute(currentSecret.lastUsedAt)} UTC`
                : "not used yet"}
            </span>
          </p>
        ) : (
          <p className="orghome-secret orghome-keymeta">No secret key issued.</p>
        )}
        {isOwner ? (
          <SecretKeyForm
            orgId={org.id}
            currentKeyId={currentSecret?.id ?? null}
            graceHours={ROTATION_GRACE_HOURS}
          />
        ) : null}
        {isOwner && currentSecret ? (
          <form action={revokeSecretKeyNowAction} className="orghome-revokecurrent">
            <input type="hidden" name="orgId" value={org.id} />
            <input type="hidden" name="keyId" value={currentSecret.id} />
            <button className="orghome-revoke" type="submit">
              Revoke — stop server-side sessions
            </button>
            {/* Allowed on the CURRENT secret key where it is not on the
                current publishable one: an org without a secret key is
                simply not using this mode, not a dead widget. */}
            <span className="orghome-keymeta">
              Immediate. Sessions already minted keep working for up to 30 minutes.
            </span>
          </form>
        ) : null}

        {retiringSecrets.length > 0 ? (
          <>
            <h3 className="orghome-subtitle">Retiring</h3>
            <ul className="orghome-keys">
              {retiringSecrets.map((k) => (
                <li className="orghome-key" key={k.id}>
                  <div className="orghome-keymain">
                    <code className="orghome-keyvalue">sk_live_…{k.suffix}</code>
                    <span className="orghome-keymeta">
                      accepted until {k.revokedAt ? utcMinute(k.revokedAt) : "—"} UTC ·{" "}
                      {k.lastUsedAt ? `last used ${utcMinute(k.lastUsedAt)} UTC` : "not used since rotation"}
                    </span>
                  </div>
                  {isOwner ? (
                    <form action={revokeSecretKeyNowAction}>
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
              A retiring key still mints sessions until the instant shown — &quot;last used&quot;
              tells you whether the old value is still deployed somewhere before you cut it short.
            </p>
          </>
        ) : null}

        {revokedSecrets.length > 0 ? (
          <p className="orghome-cardnote">
            {revokedSecrets.length === 1 ? "One earlier secret key" : `${revokedSecrets.length} earlier secret keys`}{" "}
            revoked. A revoked key is refused exactly like one that never existed.
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
