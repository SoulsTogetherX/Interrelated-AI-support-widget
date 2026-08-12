//#region Registration and authentication
// The two flows that tie the auth primitives together, against the users
// table from migration 001. Everything here returns a Result rather than
// throwing on user error — the Server Actions turn `error` strings straight
// into form feedback.
//#endregion

//#region Imports
import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { checkPasswordBreached } from "./breachedPassword"
import { emailBlindIndex, encryptEmail } from "./emailCrypto"
import { hashPassword, verifyPassword } from "./password"
import { validateEmail, validatePassword } from "./validation"
//#endregion

//#region Types
export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; error: string }
//#endregion

//#region Constants
// One error string for every way a login can fail — wrong email and wrong
// password must be indistinguishable, or the form is an account-existence
// oracle. Registration is NOT enumeration-proof ("already registered" leaks
// existence); making it proof requires a verification mailer ("if this
// address is new you will receive…"), recorded as future work rather than
// half-done. The login side is the one attackers script.
const BAD_CREDENTIALS = "Incorrect email or password."
//#endregion

//#region Timing decoy
// When login hits an unknown email, no scrypt verification would run — a
// measurably FASTER failure than a wrong password, which would let an
// attacker distinguish "no such account" from "bad password" by timing,
// defeating the uniform error above. So unknown-email failures verify
// against this throwaway hash first. Computed lazily once per process
// (hashing at module load would slow every cold start for a path only
// failed logins hit).
let decoyHash: Promise<string> | null = null

function getDecoyHash(): Promise<string> {
  decoyHash ??= hashPassword("decoy-password-never-accepted")
  return decoyHash
}
//#endregion

//#region Registration
export async function registerUser(
  emailInput: unknown,
  passwordInput: unknown,
): Promise<AuthResult> {
  const email = validateEmail(emailInput)
  if (!email.ok) {
    return { ok: false, error: email.error }
  }
  const password = validatePassword(passwordInput)
  if (!password.ok) {
    return { ok: false, error: password.error }
  }

  const breach = await checkPasswordBreached(password.value)
  if (breach.breached) {
    return {
      ok: false,
      error:
        `That password has appeared in ${breach.count.toLocaleString("en-US")} ` +
        `known data breaches — please choose a different one.`,
    }
  }

  // The id is generated BEFORE the row exists because it is the AAD binding
  // the email ciphertext to its row (emailCrypto.ts).
  const userId = newId("usr")
  const [emailIndex, passwordHash] = await Promise.all([
    emailBlindIndex(email.value),
    hashPassword(password.value),
  ])

  try {
    await db
      .insertInto("users")
      .values({
        id: userId,
        email_index: emailIndex,
        email_ciphertext: encryptEmail(email.value, userId),
        password_hash: passwordHash,
      })
      .execute()
  } catch (error) {
    // The UNIQUE on email_index is the authority on "already registered" —
    // checking first then inserting would just move the failure into a
    // race window. 23505 is Postgres's unique_violation.
    if (isUniqueViolation(error)) {
      return { ok: false, error: "That email is already registered." }
    }
    throw error
  }

  return { ok: true, userId }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  )
}
//#endregion

//#region Authentication
export async function authenticateUser(
  emailInput: unknown,
  passwordInput: unknown,
): Promise<AuthResult> {
  const email = validateEmail(emailInput)
  // A malformed email cannot match any account; fall through to the decoy
  // path with a value that will not be found, rather than returning early
  // with a DIFFERENT error that would confirm the address was parseable.
  const normalized = email.ok ? email.value : "@invalid@"
  const password = typeof passwordInput === "string" ? passwordInput : ""

  const row = await db
    .selectFrom("users")
    .select(["id", "password_hash"])
    .where("email_index", "=", await emailBlindIndex(normalized))
    .executeTakeFirst()

  if (!row) {
    // Burn the same scrypt work a real verification would (see decoy note).
    await verifyPassword(password, await getDecoyHash())
    return { ok: false, error: BAD_CREDENTIALS }
  }

  const valid = await verifyPassword(password, row.password_hash)
  if (!valid) {
    return { ok: false, error: BAD_CREDENTIALS }
  }
  return { ok: true, userId: row.id }
}
//#endregion
