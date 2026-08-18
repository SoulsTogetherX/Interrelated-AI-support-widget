// The install page: the snippet, the origin allowlist that decides where
// that snippet works, and the exact CSP directives a locked-down host
// needs. All three belong together — a customer pasting the snippet
// without allowlisting their origin gets a 403 they can't diagnose, and a
// customer with a strict CSP gets a silently dead bubble. This page is the
// answer to both, stated before they hit either.
import Link from "next/link"

import CopyButton from "@/components/CopyButton"
import OriginForm from "@/components/OriginForm"
import { listPublishableKeys } from "@/lib/keys"
import { requireOrgMember } from "@/lib/orgs"
import { listOrigins } from "@/lib/origins"
import { allowOriginNowAction, removeOriginAction } from "@/lib/origins/actions"
import { isAllowlistable, listOriginTraffic, originLabel } from "@/lib/traffic/queries"
import "./page.css"

const TRAFFIC_DAYS = 7

export const metadata = { title: "Install — Interrelated" }

/** The widget's public base URL, as the customer's page will reach it.
 *  Configured (NEXT_PUBLIC_WIDGET_API_URL) rather than derived: the
 *  dashboard runs on Vercel and the widget API on Render, so this host
 *  cannot infer the other's. Unset → the snippet renders with a visible
 *  placeholder instead of a wrong URL that would fail at the customer's
 *  site rather than here. */
function widgetApiUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_WIDGET_API_URL
  return raw && raw.trim() !== "" ? raw.trim().replace(/\/$/, "") : null
}

export default async function WidgetPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const [keys, origins, traffic] = await Promise.all([
    listPublishableKeys(org.id),
    listOrigins(org.id),
    listOriginTraffic(org.id, TRAFFIC_DAYS),
  ])
  const refusedOrigins = traffic.filter((t) => t.refused > 0 && !t.allowlisted)
  // The snippet always carries the CURRENT key. A rotation in progress is
  // worth a sentence here, because this page is where the customer copies
  // from — and the old snippet on their site is what the grace window is
  // keeping alive.
  const publishableKey = keys.find((k) => k.status === "current")?.publishableKey ?? null
  const retiring = keys.filter((k) => k.status === "retiring")
  const isOwner = org.role === "owner"
  const api = widgetApiUrl()
  const apiForSnippet = api ?? "https://YOUR-REALTIME-HOST"
  const snippet =
    `<script src="${apiForSnippet}/widget.js" async\n` +
    `        data-key="${publishableKey ?? "YOUR-PUBLISHABLE-KEY"}"\n` +
    `        data-api="${apiForSnippet}"\n` +
    `        data-title="${org.name} Support"></script>`
  const csp = `connect-src ${apiForSnippet}; script-src ${apiForSnippet};`

  return (
    <div className="install">
      <h1 className="install-title">Install the widget</h1>

      <section className="install-card">
        <h2 className="install-cardtitle">1. Allow your site&apos;s origin</h2>
        <p className="install-note">
          The widget only answers for origins you list here. The browser sets
          the <code>Origin</code> header and page JavaScript cannot forge it,
          so a copy of your snippet on someone else&apos;s site is refused
          before any model call — which is why the publishable key below is
          safe to be public.
        </p>
        {origins.length === 0 ? (
          <p className="install-empty">
            No origins allowed yet — the widget will refuse every request
            until you add one.
          </p>
        ) : (
          <ul className="install-origins">
            {origins.map((o) => (
              <li className="install-origin" key={o.origin}>
                <code>{o.origin}</code>
                {isOwner ? (
                  <form action={removeOriginAction}>
                    <input type="hidden" name="orgId" value={org.id} />
                    <input type="hidden" name="origin" value={o.origin} />
                    <button className="install-remove" type="submit">
                      Remove
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isOwner ? <OriginForm orgId={org.id} /> : null}

        {/* Layer 4 (§9.18): where the snippet was actually loaded from,
            allowlisted or not. Refused rows are the point — a copy of the
            snippet on someone else's site, or the tenant's own staging
            domain they forgot, look identical from here, and only the
            tenant can tell which; the Allow button is for the second case.
            Zero rows is a quiet week and renders as exactly that. */}
        <h3 className="install-subtitle">Where your snippet loaded — last {TRAFFIC_DAYS} days</h3>
        {traffic.length === 0 ? (
          <p className="install-note">No widget loads yet.</p>
        ) : (
          <>
            {refusedOrigins.length > 0 ? (
              <p className="install-warning">
                {refusedOrigins.length === 1 ? "One origin" : `${refusedOrigins.length} origins`} you
                have not allowlisted presented your publishable key and{" "}
                {refusedOrigins.length === 1 ? "was" : "were"} refused. If one is your own site,
                allow it; if not, someone has a copy of your snippet — the allowlist is already
                refusing it, and it never got a session.
              </p>
            ) : null}
            <div className="install-tablewrap">
              <table className="install-traffic">
                <thead>
                  <tr>
                    <th scope="col">Origin</th>
                    <th scope="col" className="install-num">Sessions</th>
                    <th scope="col" className="install-num">Refused</th>
                    {isOwner ? <th scope="col"><span className="install-srlabel">Action</span></th> : null}
                  </tr>
                </thead>
                <tbody>
                  {traffic.map((t) => (
                    <tr key={t.origin} className={t.refused > 0 && !t.allowlisted ? "install-refused" : undefined}>
                      {/* Origin and its last-seen day share a cell, and the
                          origin may wrap: four narrow columns fit a phone,
                          where five would only ever be read by scrolling. */}
                      <td className="install-origincell">
                        <code>{originLabel(t.origin)}</code>
                        <span className="install-lastseen">last seen {t.lastSeenDay} UTC</span>
                      </td>
                      <td className="install-num">{t.minted.toLocaleString("en-US")}</td>
                      <td className="install-num">{t.refused.toLocaleString("en-US")}</td>
                      {isOwner ? (
                        <td>
                          {t.refused > 0 && !t.allowlisted && isAllowlistable(t.origin) ? (
                            <form action={allowOriginNowAction}>
                              <input type="hidden" name="orgId" value={org.id} />
                              <input type="hidden" name="origin" value={t.origin} />
                              <button className="install-allow" type="submit">
                                Allow
                              </button>
                            </form>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="install-note">
              Counted per origin per UTC day on every attempt that presented your key — sessions
              for allowlisted origins, refusals for the rest. No visitor identity is stored:
              an origin and a count, nothing else.
            </p>
          </>
        )}
      </section>

      <section className="install-card">
        <h2 className="install-cardtitle">2. Paste the snippet</h2>
        <p className="install-note">
          Anywhere in your page — the script is async, ~4 KB gzipped, has no
          dependencies, and renders inside a Shadow DOM so your styles and
          the widget&apos;s cannot reach each other.
        </p>
        <pre className="install-snippet">{snippet}</pre>
        <CopyButton text={snippet} label="Copy snippet" />
        {api === null ? (
          <p className="install-warning">
            This deployment has no <code>NEXT_PUBLIC_WIDGET_API_URL</code>{" "}
            configured, so the snippet above shows a placeholder host.
            Replace it with your realtime service URL, or set that variable
            and reload.
          </p>
        ) : null}
        {publishableKey === null ? (
          <p className="install-warning">
            This organization has no live publishable key — unexpected;
            contact support before installing.
          </p>
        ) : null}
        {retiring.length > 0 ? (
          <p className="install-warning">
            A key rotation is in progress: the snippet above carries your new
            key. {retiring.length === 1 ? "Your previous key is" : `${retiring.length} previous keys are`}{" "}
            still accepted until{" "}
            {retiring
              .map((k) => (k.revokedAt ? k.revokedAt.toISOString().slice(0, 16).replace("T", " ") : "—"))
              .join(", ")}{" "}
            UTC — deploy this snippet before then. Manage retiring keys from the{" "}
            <Link href={`/dashboard/${org.id}`}>overview</Link>.
          </p>
        ) : null}
      </section>

      <section className="install-card">
        <h2 className="install-cardtitle">3. If your site sends a CSP</h2>
        <p className="install-note">
          Two directives, and only these two. The widget&apos;s styles ride{" "}
          <code>adoptedStyleSheets</code>, which CSP does not govern, so no{" "}
          <code>style-src</code> entry is needed — a claim we test against a
          fixture page whose CSP deliberately withholds one.
        </p>
        <pre className="install-snippet">{csp}</pre>
        <CopyButton text={csp} label="Copy directives" />
      </section>

      <p className="install-back">
        <Link href={`/dashboard/${org.id}`}>Back to {org.name}</Link>
      </p>
    </div>
  )
}
