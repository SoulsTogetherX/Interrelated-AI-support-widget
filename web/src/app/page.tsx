// The public landing page. Plain <a> instead of next/link ON PURPOSE: the
// page test renders this component with react-dom/server OUTSIDE the Next
// runtime (where Link does not render), and prefetch on a two-route site
// buys nothing — a full navigation to /login is the honest cost.
import "./page.css"

export default function LandingPage() {
  return (
    <main className="landing">
      <h1 className="landing-title">Interrelated</h1>
      <p className="landing-tagline">
        An embeddable AI support widget that answers from your documentation with citations your
        visitors can check — every quoted span verified against the source before it is shown, and
        unverifiable claims stripped, not softened.
      </p>
      <p className="landing-actions">
        <a className="landing-cta" href="/login">
          Sign in
        </a>
        <a className="landing-cta landing-cta-secondary" href="/signup">
          Create an account
        </a>
      </p>
    </main>
  )
}
