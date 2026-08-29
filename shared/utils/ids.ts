//#region Imports
// node:crypto is available in every runtime this repo targets (Node 22+ in
// the realtime service and tooling; the widget generates visitor ids with the
// browser's crypto through the same interface shape, but does NOT import this
// file — it has a zero-dependency copy, because importing shared/ would drag
// tooling assumptions into a bundle with a 15 KB budget).
import { createHash, randomBytes } from "node:crypto"
//#endregion

//#region Type Defs
// Every row id in the database is TEXT, generated here — never SERIAL.
// Prefixed ids (org_…, usr_…) make logs, foreign keys, and support tickets
// self-describing: you can tell what table an id belongs to from the id
// alone, which matters in a multi-tenant system where a mixed-up id is a
// cross-tenant bug. Stripe popularized this shape for exactly that reason.
//
// The union is closed on purpose: adding a new entity requires touching this
// file, which keeps the prefix registry in one reviewable place.
type IdPrefix =
  | "org" // organizations
  | "usr" // users
  | "mem" // org_members
  | "ses" // sessions (dashboard login)
  | "key" // api_keys (publishable + secret widget keys)
  | "prv" // org_provider_credentials (BYO provider key rows)
  | "ori" // allowed_origins
  | "src" // sources (a crawl target or upload)
  | "doc" // documents (one fetched page / uploaded file)
  | "chk" // chunks (one retrieval unit within a document)
  | "job" // ingest_jobs (queue rows for the ingest worker)
  | "con" // conversations (one widget chat thread)
  | "msg" // messages (one turn within a conversation)
  | "hnd" // handoff_sessions (one escalation of a conversation to a human)
//#endregion

//#region Constants
// 20 random bytes → 160 bits of entropy, comfortably collision-free without
// coordination. Encoded in lowercase base32 (Crockford alphabet, no padding)
// rather than hex or base64: base32 survives case-insensitive contexts
// (hostnames, some log pipelines) and avoids base64's "+/" which break URLs
// and double-click selection. 160 bits / 5 bits-per-char = 32 chars exactly.
const ID_BYTES = 20
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz" // Crockford: no i,l,o,u
//#endregion

//#region Helpers
// Encodes a buffer into Crockford base32. Hand-rolled (rather than a
// dependency) because it is 15 lines, and shared/ must stay dependency-free
// so every consumer can compile it without a package install.
function toBase32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  // 20 bytes = 160 bits divides evenly by 5, so there is never a partial
  // group to flush. The assertion documents the invariant instead of
  // silently depending on it.
  if (bits !== 0) throw new Error("ID_BYTES must be a multiple of 5")
  return out
}
//#endregion

//#region Exports
/**
 * Generates a new entity id: `<prefix>_<32 chars of base32>`, e.g.
 * `org_9m4e2mr0ui3e8a215n4g5t6q7rjkfwd3`. Total length is fixed
 * (prefix + 1 + 32), which lets the schema use CHECK (char_length(...))
 * constraints as a cheap defense against ids fabricated by hand.
 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${toBase32(randomBytes(ID_BYTES))}`
}

/**
 * True when `value` is a well-formed id for `prefix`. Used at API boundaries
 * to reject malformed ids before they reach a query — a malformed id is
 * never a valid lookup, so failing fast avoids a pointless round-trip and
 * keeps garbage out of logs.
 */
export function isId(prefix: IdPrefix, value: string): boolean {
  if (!value.startsWith(`${prefix}_`)) return false
  const body = value.slice(prefix.length + 1)
  if (body.length !== 32) return false
  for (const ch of body) {
    if (!ALPHABET.includes(ch)) return false
  }
  return true
}

/**
 * Generates a publishable widget key: `pk_live_<32 chars of base32>`.
 * Lives here rather than in web/ (its only minter today) because the VALUE
 * format is a cross-package contract exactly like entity ids: realtime's
 * session route looks it up verbatim and gates on the `pk_` prefix
 * (realtime/src/routes/widget.ts), and the customer pastes it into their
 * snippet. Not an entity id on purpose — api_keys rows have their own
 * `key_…` id; this is the CREDENTIAL the row carries, and keeping the two
 * shapes visibly different is what stops one being used as the other.
 * "live" is the only mode that exists; a test-mode variant would slot in
 * here the way Stripe's pk_test_ does.
 */
export function newPublishableKey(): string {
  return `pk_live_${toBase32(randomBytes(ID_BYTES))}`
}

/**
 * Generates a SECRET widget key: `sk_live_<32 chars of base32>` — trust-model
 * layer 6, the credential a customer's own backend presents to
 * POST /v1/sessions to mint a session for a user it has authenticated
 * (realtime/src/routes/widget.ts). Same shape and entropy as the publishable
 * key, different prefix on purpose: the session routes gate on the prefix
 * before any lookup, so a secret pasted where a publishable key belongs (or
 * the reverse) is refused for its shape and never reaches a query. Minted by
 * the dashboard (web/src/lib/keys), which shows the value exactly ONCE and
 * stores only its hash — the same posture as dashboard session cookies.
 */
export function newSecretKey(): string {
  return `sk_live_${toBase32(randomBytes(ID_BYTES))}`
}

/**
 * The storage form of a secret key: sha256 hex, which is what
 * `api_keys.secret_hash` holds and what the session route looks a bearer up
 * by. Lives beside the generator because it is the OTHER half of the same
 * cross-package contract — the dashboard writes this on issue, realtime
 * computes it per request — and two packages hashing "the same way" by
 * convention is how one of them ends up hashing differently. Plain sha256
 * rather than a slow KDF, deliberately: the input is 160 random bits, not a
 * human password, so there is nothing for a slow hash to defend against and
 * every mint would pay it (the same argument sessions.id makes).
 */
export function hashSecretKey(secretKey: string): string {
  return createHash("sha256").update(secretKey).digest("hex")
}

/**
 * The last four characters of a secret key — the only fragment the dashboard
 * keeps in plaintext (`api_keys.secret_suffix`), so an owner can tell which
 * key their server holds ("sk_live_…k3p9") without the value ever being shown
 * again. Four base32 characters are 20 of 160 bits; the rest stays
 * unguessable. The provider-credential vault keeps a suffix for the same
 * reason (realtime/src/credentials/vault.ts).
 */
export function secretKeySuffix(secretKey: string): string {
  return secretKey.slice(-4)
}

export type { IdPrefix }
//#endregion
