//#region Why this shape
// Session lifecycle against the sessions table from §3.3, ported
// from OnlineWhiteboard's session.ts with its Express req/res halves
// replaced by cookies.ts (Next's cookie jar lives in next/headers, which
// only exists inside a request scope — keeping it OUT of this file is what
// lets these functions run under plain vitest against a real database).
//
// The cookie carries a raw random token; the database stores only its
// SHA-256 — sessions.id IS the hash (the migration CHECKs char_length 64).
// A plain unsalted hash is correct here, unlike for passwords: the token is
// 256 bits of randomness, so there is nothing to brute-force and no reason
// to slow lookups down. Hashing just means a stolen database dump cannot be
// replayed as live sessions.
//#endregion

//#region Imports
import { createHash, randomBytes } from "node:crypto"

import { db } from "@/lib/db"
import { decryptEmail } from "./emailCrypto"
//#endregion

//#region Constants
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
//#endregion

//#region Types
/** What a signed-in request knows about its user. email is DECRYPTED here —
 *  the one place ciphertext becomes plaintext on the read path — because
 *  every consumer (the dashboard chrome, the account page) wants the
 *  address, and decrypting at the session boundary keeps ciphertext from
 *  leaking into component props under its own name. */
export interface SessionUser {
  id: string
  email: string
}
//#endregion

//#region Token hashing
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
//#endregion

//#region Session lifecycle
export async function createSessionForUser(
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db
    .insertInto("sessions")
    .values({ id: hashSessionToken(token), user_id: userId, expires_at: expiresAt })
    .execute()
  return { token, expiresAt }
}

// Resolves a raw cookie token to its user, or null if there is no token, no
// matching session, or the session has expired. Expiry is checked in SQL
// against the database clock — the same clock that wrote expires_at — so a
// skewed app server cannot extend a session's life.
export async function resolveSessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token) {
    return null
  }
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select(["users.id as id", "users.email_ciphertext as email_ciphertext"])
    .where("sessions.id", "=", hashSessionToken(token))
    .where("sessions.expires_at", ">", new Date())
    .executeTakeFirst()
  if (!row) {
    return null
  }
  return { id: row.id, email: decryptEmail(row.email_ciphertext, row.id) }
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) {
    return
  }
  await db.deleteFrom("sessions").where("id", "=", hashSessionToken(token)).execute()
}
//#endregion
