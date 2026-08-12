//#region Cookie I/O
// The Next half of session handling — everything that touches
// next/headers, which only exists inside a request scope. Separated from
// session.ts so the lifecycle functions stay testable under plain vitest.
//
// The `__Host-` prefix is browser-enforced hardening: a cookie with this
// prefix is only accepted if it is Secure, has Path=/, and has NO Domain —
// pinning it to exactly this host and blocking a subdomain from setting or
// overwriting it. It REQUIRES Secure (HTTPS), so dev over plain http uses
// the bare name. SameSite=Lax is the plan's stated choice: the dashboard
// proxies realtime calls through its own origin, so the browser only ever
// talks to Vercel and Lax never gets in the way.
//#endregion

//#region Imports
import { cookies } from "next/headers"
//#endregion

//#region Constants
const IS_PROD = process.env.NODE_ENV === "production"

export const SESSION_COOKIE = IS_PROD ? "__Host-sid" : "sid"
//#endregion

//#region Cookie jar helpers
export async function setSessionCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, // unreadable from JS — blunts XSS session theft
    sameSite: "lax", // not sent on cross-site requests — blunts CSRF
    secure: IS_PROD, // HTTPS-only in prod; off in dev so http://localhost works
    path: "/",
    expires: expiresAt,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    path: "/",
    expires: new Date(0),
  })
}

export async function readSessionToken(): Promise<string | undefined> {
  const jar = await cookies()
  return jar.get(SESSION_COOKIE)?.value
}
//#endregion
