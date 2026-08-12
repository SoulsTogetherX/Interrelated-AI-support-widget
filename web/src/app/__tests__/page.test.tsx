// The landing page is a Server Component — a plain synchronous function —
// so it renders with react-dom/server and no DOM. Since M3.2 the page's job
// is to route people to sign-in: the tests pin the product name, the
// thesis, and that both auth links exist (this suite is why the page uses
// plain <a> over next/link — it renders outside the Next runtime).
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import LandingPage from "../page"

describe("landing page", () => {
  it("renders the product name and thesis", () => {
    const html = renderToStaticMarkup(<LandingPage />)
    expect(html).toContain("Interrelated")
    expect(html).toContain("verified")
  })

  it("links to sign-in and sign-up", () => {
    const html = renderToStaticMarkup(<LandingPage />)
    expect(html).toContain('href="/login"')
    expect(html).toContain('href="/signup"')
  })
})
