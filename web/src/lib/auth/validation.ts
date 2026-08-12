//#region Request validation
// Hand-written validators for the auth inputs, ported from OnlineWhiteboard
// (backend/src/auth/validation.ts) minus its username validator —
// Interrelated identifies dashboard users by email alone. Dependency-free on
// purpose (the same stance as shared/grounding's validator): the contract is
// two fields, smaller than any schema library. Each returns a normalized
// value or an error message a form can show verbatim.
//#endregion

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

// Intentionally permissive — the real proof an address exists is a
// verification email (future work, needs a mailer). This rejects obvious
// nonsense and normalizes case so "A@x.com" and "a@x.com" are one account —
// which the blind index then guarantees (emailCrypto.ts is keyed on the
// NORMALIZED address, so normalization drift would orphan accounts).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Email is required." }
  }
  const email = input.trim().toLowerCase()
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: "Enter a valid email address." }
  }
  return { ok: true, value: email }
}

// A tiny blocklist of the passwords that dominate every breach corpus. This
// is a FLOOR under the real control — the HIBP k-anonymity check in
// breachedPassword.ts — kept because that check fails open on network
// trouble and these should never pass even then.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwerty123", "qwertyuiop", "1q2w3e4r", "iloveyou", "admin123", "letmein",
  "welcome1", "monkey123", "abc12345", "111111111", "000000000", "sunshine",
  "princess", "football", "baseball", "trustno1", "dragon123", "passw0rd",
  "changeme", "interrelated",
])

export function validatePassword(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Password is required." }
  }
  // Length is the single biggest factor in password strength; 8 is a floor,
  // and the upper bound matters because scrypt hashes the whole input — a
  // megabyte-long "password" is a cheap denial-of-service.
  if (input.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." }
  }
  if (input.length > 200) {
    return { ok: false, error: "Password must be at most 200 characters." }
  }
  if (COMMON_PASSWORDS.has(input.toLowerCase())) {
    return {
      ok: false,
      error: "That password is too common — please choose another.",
    }
  }
  return { ok: true, value: input }
}
