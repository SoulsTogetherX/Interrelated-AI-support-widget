//#region Why this file
// The origin allowlist — trust-model layer 1, the layer that kills the
// copy-pasted-snippet attack outright (CLAUDE.md's trust model). Unlike
// provider credentials, these rows hold NO secret, so web writes them
// directly through Kysely instead of proxying to realtime's internal API:
// the API exists for things web cannot or must not do (decrypt keys, poke
// the in-process worker), and routing plain rows through it would be
// ceremony without a reason.
//
// The validator here mirrors the schema CHECK (`^https?://[^/]+$`) rather
// than trusting it: a constraint violation is a 500 the tenant can't act
// on, while "origins have no path or trailing slash" is a sentence they
// can. The CHECK stays as the backstop that makes a bypass unrepresentable.
//#endregion

//#region Imports
import { db } from "@/lib/db"

import type { Validated } from "@/lib/auth/validation"
//#endregion

//#region Types
export interface AllowedOrigin {
  origin: string
  createdAt: Date
}
//#endregion

//#region Validation
/** Normalizes what a customer will realistically paste — a full page URL,
 *  a trailing slash, stray whitespace, mixed-case host — into the exact
 *  scheme://host[:port] string the widget route compares against. It
 *  deliberately does NOT accept a bare host: "example.com" is ambiguous
 *  about scheme, and guessing https for someone's allowlist would be us
 *  deciding their security posture. */
export function validateOrigin(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "An origin is required." }
  }
  const raw = input.trim()
  if (raw === "") {
    return { ok: false, error: "An origin is required." }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      ok: false,
      error: "Enter a full origin including the scheme, e.g. https://docs.example.com",
    }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "An origin must use http:// or https://" }
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "An origin must not embed credentials." }
  }
  // url.origin is exactly scheme://host[:port] — the browser's own
  // definition, which is precisely what the Origin header will carry, so
  // paths, queries, and trailing slashes fall away here rather than
  // becoming an allowlist entry that can never match.
  const origin = url.origin
  if (origin === "null" || !/^https?:\/\/[^/]+$/.test(origin)) {
    return { ok: false, error: "That is not a valid origin." }
  }
  if (origin.length > 253) {
    return { ok: false, error: "That origin is too long." }
  }
  return { ok: true, value: origin }
}
//#endregion

//#region Queries
export async function listOrigins(orgId: string): Promise<AllowedOrigin[]> {
  const rows = await db
    .selectFrom("allowed_origins")
    .select(["origin", "created_at"])
    .where("org_id", "=", orgId)
    .orderBy("created_at", "asc")
    .execute()
  return rows.map((r) => ({ origin: r.origin, createdAt: r.created_at }))
}

/** Idempotent by design: re-adding an existing origin is a no-op success,
 *  not an error — the tenant's intent ("this origin should be allowed") is
 *  already satisfied, and a duplicate-key error would just be noise. */
export async function addOrigin(orgId: string, origin: string): Promise<void> {
  await db
    .insertInto("allowed_origins")
    .values({ org_id: orgId, origin })
    .onConflict((oc) => oc.columns(["org_id", "origin"]).doNothing())
    .execute()
}

export async function removeOrigin(orgId: string, origin: string): Promise<void> {
  await db
    .deleteFrom("allowed_origins")
    .where("org_id", "=", orgId)
    .where("origin", "=", origin)
    .execute()
}
//#endregion
