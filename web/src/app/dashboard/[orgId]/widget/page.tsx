// The install page: the snippet, the origin allowlist that decides where
// that snippet works, and the exact CSP directives a locked-down host
// needs. All three belong together — a customer pasting the snippet
// without allowlisting their origin gets a 403 they can't diagnose, and a
// customer with a strict CSP gets a silently dead bubble. This page is the
// answer to both, stated before they hit either.
import Link from "next/link"

import CopyButton from "@/components/CopyButton"
import OriginForm from "@/components/OriginForm"
import { requireOrgMember, getPublishableKey } from "@/lib/orgs"
import { listOrigins } from "@/lib/origins"
import { removeOriginAction } from "@/lib/origins/actions"
import "./page.css"

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
  const [publishableKey, origins] = await Promise.all([
    getPublishableKey(org.id),
    listOrigins(org.id),
  ])
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
