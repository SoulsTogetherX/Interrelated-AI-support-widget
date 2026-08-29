// The install page: the snippet, the origin allowlist that decides where
// that snippet works, and the exact CSP directives a locked-down host
// needs. All three belong together — a customer pasting the snippet
// without allowlisting their origin gets a 403 they can't diagnose, and a
// customer with a strict CSP gets a silently dead bubble. This page is the
// answer to both, stated before they hit either.
import Link from "next/link"

import CopyButton from "@/components/CopyButton"
import OriginForm from "@/components/OriginForm"
import { listPublishableKeys, listSecretKeys } from "@/lib/keys"
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

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
export default async function WidgetPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const [keys, secretKeys, origins, traffic] = await Promise.all([
    listPublishableKeys(org.id),
    listSecretKeys(org.id),
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
  const currentSecret = secretKeys.find((k) => k.status === "current") ?? null
  const isOwner = org.role === "owner"
  const api = widgetApiUrl()
  const apiForSnippet = api ?? "https://YOUR-REALTIME-HOST"
  const snippet =
    `<script src="${apiForSnippet}/widget.js" async\n` +
    `        data-key="${publishableKey ?? "YOUR-PUBLISHABLE-KEY"}"\n` +
    `        data-api="${apiForSnippet}"\n` +
    `        data-title="${org.name} Support"></script>`
  // connect-src names the API host TWICE — as https:// for the fetches and
  // as wss:// for the handoff socket — because CSP's scheme matching only
  // ever goes http→https, never http→ws (CSP3 §6.7.2.6): a directive that
  // lists only the https origin lets chat work and silently blocks the
  // human handoff, which is what a rejoin on the hostile fixture showed
  // (M7.4). The socket URL is the api URL with its scheme swapped
  // (widget/src/handoff.ts), so this is derived, not a second setting.
  const socketForSnippet = apiForSnippet.replace(/^https:/, "wss:").replace(/^http:/, "ws:")
  const csp = `connect-src ${apiForSnippet} ${socketForSnippet}; script-src ${apiForSnippet};`
  // Strong mode (layer 6, §9.19): the customer's server mints the session,
  // and the snippet names the endpoint on THEIR site that hands it over —
  // no publishable key on the page at all. The origin in the recipe is the
  // first allowlisted one, so what they copy matches what the route checks.
  const strongOrigin = origins[0]?.origin ?? "https://app.example.com"
  const strongSnippet =
    `<script src="${apiForSnippet}/widget.js" async\n` +
    `        data-session-url="/api/support-session"\n` +
    `        data-api="${apiForSnippet}"\n` +
    `        data-title="${org.name} Support"></script>`
  const endpointRecipe =
    `// GET /api/support-session — on YOUR server, behind YOUR login. Node 18+ shown;\n` +
    `// any language works: one authenticated POST, and pass the answer through.\n` +
    `app.get("/api/support-session", async (req, res) => {\n` +
    `  const user = await requireSignedInUser(req)          // your session check\n` +
    `  const upstream = await fetch("${apiForSnippet}/v1/sessions", {\n` +
    `    method: "POST",\n` +
    `    headers: {\n` +
    `      authorization: \`Bearer \${process.env.INTERRELATED_SECRET_KEY}\`,\n` +
    `      "content-type": "application/json",\n` +
    `    },\n` +
    `    body: JSON.stringify({\n` +
    `      origin: "${strongOrigin}",   // the origin this page runs on — allowlisted above\n` +
    `      visitorId: String(user.id),  // your stable user id: letters, digits, _ and - (not an email)\n` +
    `    }),\n` +
    `  })\n` +
    `  res.status(upstream.status)\n` +
    `    .set("cache-control", "no-store")\n` +
    `    .type("json")\n` +
    `    .send(await upstream.text())                       // {token, expiresAt, visitorId} — verbatim\n` +
    `})`

  return (
    <div className="install">
      <h1 className="install-title">Install the widget</h1>

      <section className="install-card">
        <h2 className="install-cardtitle">1. Allow your site&apos;s origin</h2>
        <p className="install-note">
          The widget only answers for origins you list here. The browser sets the{" "}
          <code>Origin</code> header and page JavaScript cannot forge it, so a copy of your snippet
          on someone else&apos;s site is refused before any model call — which is why the
          publishable key below is safe to be public.
        </p>
        {origins.length === 0 ? (
          <p className="install-empty">
            No origins allowed yet — the widget will refuse every request until you add one.
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
                {refusedOrigins.length === 1 ? "One origin" : `${refusedOrigins.length} origins`}{" "}
                you have not allowlisted presented your publishable key and{" "}
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
                    <th scope="col" className="install-num">
                      Sessions
                    </th>
                    <th scope="col" className="install-num">
                      Refused
                    </th>
                    {isOwner ? (
                      <th scope="col">
                        <span className="install-srlabel">Action</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {traffic.map((t) => (
                    <tr
                      key={t.origin}
                      className={t.refused > 0 && !t.allowlisted ? "install-refused" : undefined}
                    >
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
              Counted per origin per UTC day on every attempt that presented your key — sessions for
              allowlisted origins, refusals for the rest. No visitor identity is stored: an origin
              and a count, nothing else.
            </p>
          </>
        )}
      </section>

      <section className="install-card">
        <h2 className="install-cardtitle">2. Paste the snippet</h2>
        <p className="install-note">
          Anywhere in your page — the script is async, ~4 KB gzipped, has no dependencies, and
          renders inside a Shadow DOM so your styles and the widget&apos;s cannot reach each other.
        </p>
        <pre className="install-snippet">{snippet}</pre>
        <CopyButton text={snippet} label="Copy snippet" />
        {api === null ? (
          <p className="install-warning">
            This deployment has no <code>NEXT_PUBLIC_WIDGET_API_URL</code> configured, so the
            snippet above shows a placeholder host. Replace it with your realtime service URL, or
            set that variable and reload.
          </p>
        ) : null}
        {publishableKey === null ? (
          <p className="install-warning">
            This organization has no live publishable key — unexpected; contact support before
            installing.
          </p>
        ) : null}
        {retiring.length > 0 ? (
          <p className="install-warning">
            A key rotation is in progress: the snippet above carries your new key.{" "}
            {retiring.length === 1
              ? "Your previous key is"
              : `${retiring.length} previous keys are`}{" "}
            still accepted until{" "}
            {retiring
              .map((k) =>
                k.revokedAt ? k.revokedAt.toISOString().slice(0, 16).replace("T", " ") : "—",
              )
              .join(", ")}{" "}
            UTC — deploy this snippet before then. Manage retiring keys from the{" "}
            <Link href={`/dashboard/${org.id}`}>overview</Link>.
          </p>
        ) : null}
      </section>

      <section className="install-card">
        <h2 className="install-cardtitle">3. If your site sends a CSP</h2>
        <p className="install-note">
          Two directives, and only these two. The API host appears twice in <code>connect-src</code>{" "}
          on purpose: once for the widget&apos;s requests and once as <code>wss://</code> for the
          socket that carries a human handoff — a CSP that lists only the <code>https://</code>{" "}
          origin lets chat work and silently blocks the handoff. The widget&apos;s styles ride{" "}
          <code>adoptedStyleSheets</code>, which CSP does not govern, so no <code>style-src</code>{" "}
          entry is needed — a claim we test against a fixture page whose CSP deliberately withholds
          one.
        </p>
        <pre className="install-snippet">{csp}</pre>
        <CopyButton text={csp} label="Copy directives" />
      </section>

      <section className="install-card">
        <h2 className="install-cardtitle">4. Optional — sessions minted by your server</h2>
        {/* Layer 6 (§9.19), stated as what it changes: WHO proves the visitor
            is allowed. With the publishable key, the browser does, and the
            allowlist plus rate limits bound a copied snippet; with the secret
            key, YOUR server does — only a user you have signed in gets a
            session, under an id you chose, and the page carries nothing worth
            copying. */}
        <p className="install-note">
          By default the page above proves nothing about the visitor — the widget is for anyone on
          your allowlisted site. If your users sign in, your server can mint the widget session
          instead: it calls us with your <strong>secret key</strong> and your user&apos;s id, hands
          the token to the page, and the page carries no publishable key at all. Only your logged-in
          users can open a chat, and the transcript shows <em>which</em> user — an identity your
          server asserted, which a browser cannot forge.
        </p>
        <p className="install-note">
          {currentSecret ? (
            <>
              This organization has a secret key ending in <code>…{currentSecret.suffix}</code>
              {currentSecret.lastUsedAt ? " (in use)" : " (not used yet)"}. Rotate or revoke it from
              the <Link href={`/dashboard/${org.id}`}>overview</Link>.
            </>
          ) : (
            <>
              No secret key yet — {isOwner ? "generate one" : "the owner can generate one"} on the{" "}
              <Link href={`/dashboard/${org.id}`}>overview</Link>. It is shown once and belongs in
              your server&apos;s configuration, never in a page.
            </>
          )}
        </p>
        <h3 className="install-subtitle">a. An endpoint on your server, behind your login</h3>
        <pre className="install-snippet">{endpointRecipe}</pre>
        <CopyButton text={endpointRecipe} label="Copy endpoint recipe" />
        <p className="install-note">
          A 403 with <code>origin not allowed</code> means the origin your server named is not
          allowlisted in section 1 — the attempt shows up in the table there with an Allow button.
          The token lasts 30 minutes; the widget calls your endpoint again on its own when it
          expires, so the endpoint should not be cacheable and should keep answering while the user
          is signed in.
        </p>
        <h3 className="install-subtitle">b. The snippet, without a publishable key</h3>
        <pre className="install-snippet">{strongSnippet}</pre>
        <CopyButton text={strongSnippet} label="Copy strong-mode snippet" />
        <p className="install-note">
          <code>data-session-url</code> replaces <code>data-key</code>: the widget fetches its
          session from that URL on your site (same-origin, with the user&apos;s cookies) instead of
          minting one with a publishable key. Signed-out users get whatever your endpoint answers
          them — a 401 renders as the widget being unable to start, so most sites simply omit the
          snippet on pages that do not require sign-in.
        </p>
      </section>

      <p className="install-back">
        <Link href={`/dashboard/${org.id}`}>Back to {org.name}</Link>
      </p>
    </div>
  )
}
