//#region Why this file
// The at-rest encryption for tenant provider keys — the plan's most serious
// failure mode is one of these leaking, because it is someone else's money
// and account. Same construction as web's email-at-rest (AES-256-GCM,
// versioned format, AAD binds ciphertext to row) but a DIFFERENT master key
// held by a DIFFERENT service: CREDENTIAL_MASTER_KEY exists only on
// realtime, so the dashboard — which handles the plaintext for the seconds
// between paste and save — can never DECRYPT anything at rest, and a web-
// side compromise does not unlock the credential table.
//
// No blind index here, unlike emails: nothing ever looks a credential up BY
// key (lookups are by org + role), so a searchable digest would be pure
// attack surface.
//
// Fail-closed rule: there is NO dev fallback key. Email crypto tolerates a
// published dev key because dev accounts are throwaway; a provider key is
// real even in dev (it spends real quota), so encrypting it under a known
// constant would be silently worthless. Missing key → the internal API
// simply does not mount (server.ts), and constructing the vault throws.
//#endregion

//#region Imports
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
//#endregion

//#region Constants
const KEY_LENGTH = 32 // AES-256
const IV_LENGTH = 12 // GCM's specified nonce size
const FORMAT_VERSION = "v1"
//#endregion

//#region Key loading
/** Parses CREDENTIAL_MASTER_KEY (32 bytes, base64). Throws on absence or
 *  wrong length — callers decide whether that aborts boot (yes, when the
 *  internal API is enabled) or just leaves the surface unmounted. */
function loadMasterKey(): Buffer {
  const raw = process.env.CREDENTIAL_MASTER_KEY
  if (!raw) {
    throw new Error(
      "CREDENTIAL_MASTER_KEY is not set. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    )
  }
  const key = Buffer.from(raw, "base64")
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `CREDENTIAL_MASTER_KEY must be ${KEY_LENGTH} bytes of base64 (got ${key.length}).`,
    )
  }
  return key
}

export function hasMasterKey(): boolean {
  return Boolean(process.env.CREDENTIAL_MASTER_KEY)
}
//#endregion

//#region Encrypt / decrypt
/** Format: v1.<iv>.<authTag>.<ciphertext>, all base64 — same self-describing
 *  shape as email-at-rest, so a future key rotation can branch on version.
 *  AAD = the credential row's id: a ciphertext copied onto another row (an
 *  attacker with write access trying to point org A at org B's key, or a
 *  botched restore) fails authentication instead of decrypting. */
export function encryptProviderKey(plaintextKey: string, credentialId: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", loadMasterKey(), iv)
  cipher.setAAD(Buffer.from(credentialId, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(plaintextKey, "utf8"), cipher.final()])
  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".")
}

/** Throws on tampering, truncation, or a moved ciphertext — authentication
 *  failure IS the tamper signal and must never soften into a null. The
 *  error message deliberately never includes the payload. */
export function decryptProviderKey(payload: string, credentialId: string): string {
  const parts = payload.split(".")
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Unrecognised credential ciphertext format.")
  }
  const [, ivB64, tagB64, dataB64] = parts
  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadMasterKey(),
    Buffer.from(ivB64, "base64"),
  )
  decipher.setAAD(Buffer.from(credentialId, "utf8"))
  decipher.setAuthTag(Buffer.from(tagB64, "base64"))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8")
}

/** The display fragment: the last 4 characters, the industry-standard
 *  "…a3f9". Computed at save time and stored, so display NEVER decrypts. */
export function keySuffix(plaintextKey: string): string {
  return plaintextKey.slice(-4)
}
//#endregion
