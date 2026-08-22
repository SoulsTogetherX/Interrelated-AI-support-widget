//#region Why this file
// Dev-only CLI (`npm run seed-playground`, normally invoked by the root
// playground orchestrator): gives the seeded demo org a DASHBOARD LOGIN.
//
// realtime's seed-demo creates the org, its publishable key, the fixture
// origins and the corpus — but no user and no membership, because users are
// web's domain: the password hash, the HIBP screen, and the encrypted-email
// blind index all live in web/src/lib/auth, and a second implementation in
// realtime would drift (the same argument that put this file HERE rather
// than teaching seed-demo about scrypt). Sibling of realtime/scripts' CLIs:
// glue over the same functions the product runs, no logic of its own.
//
// Everything is idempotent — the orchestrator runs it on every boot.
//#endregion

//#region Imports
import { db } from "@/lib/db"
import { registerUser, authenticateUser } from "@/lib/auth/user"
import { emailBlindIndex } from "@/lib/auth/emailCrypto"
//#endregion

//#region Constants
/** Must match realtime/scripts/seedWidgetDemo.ts's ORG_NAME — the org this
 *  login gets attached to. */
const ORG_NAME = "Widget Demo Org"
/** Fixed, memorable, and local-only. The seed detects a changed password
 *  rather than failing, so the account stays usable either way. Note the
 *  password must clear validation's common-password blocklist —
 *  "interrelated" alone is on it; this phrase is not. */
const EMAIL = "play@interrelated.local"
const PASSWORD = "play-with-interrelated"
/**
 * The /demo page's own origins. GET /demo serves the widget with
 * data-api="" (same-origin), so its session mint arrives with
 * Origin: http://localhost:3000 — which seed-demo never allowlists (it only
 * knows the :4400 fixture origins). Without these rows the demo page renders
 * and then 403s every mint, which reads as "the widget is broken".
 */
const DEMO_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]
//#endregion

//#region Helpers
const UNIQUE_VIOLATION = "23505"

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION
}

/** The user's id whatever the password situation: register → authenticate →
 *  blind-index lookup, in that order. The last rung exists because the
 *  account may already exist WITH A DIFFERENT PASSWORD (someone played and
 *  changed it); membership should still be wired, and the banner tells the
 *  user to sign in with the password they set. */
async function ensureUser(): Promise<{ userId: string; passwordChanged: boolean }> {
  const registered = await registerUser(EMAIL, PASSWORD)
  if (registered.ok) return { userId: registered.userId, passwordChanged: false }

  const authenticated = await authenticateUser(EMAIL, PASSWORD)
  if (authenticated.ok) return { userId: authenticated.userId, passwordChanged: false }

  const index = await emailBlindIndex(EMAIL)
  const row = await db.selectFrom("users").select("id").where("email_index", "=", index).executeTakeFirst()
  if (!row) {
    // Neither creatable nor findable — registerUser's error is the real story.
    throw new Error(`could not create or find ${EMAIL}: ${registered.error}`)
  }
  return { userId: row.id, passwordChanged: true }
}

/**
 * Wires the user into the org under the one-owner constraint (the partial
 * unique index org_members_one_owner: at most one 'owner' row per org).
 * seed-demo creates the org OWNERLESS, so the first playground run takes
 * owner; every 23505 here is a race or a pre-existing owner, and the honest
 * degradation is 'agent' — the inbox and conversations still work, and the
 * report says which role was granted.
 */
async function ensureMembership(orgId: string, userId: string): Promise<"owner" | "agent"> {
  const existing = await db
    .selectFrom("org_members")
    .select("role")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .executeTakeFirst()
  if (existing?.role === "owner") return "owner"

  const owner = await db
    .selectFrom("org_members")
    .select("user_id")
    .where("org_id", "=", orgId)
    .where("role", "=", "owner")
    .executeTakeFirst()

  if (existing) {
    // Already an agent. Promote only if the seat is empty — the UPDATE can
    // still lose a race to a concurrent owner, which the index turns into a
    // unique violation rather than two owners.
    if (owner) return "agent"
    try {
      await db.updateTable("org_members")
        .set({ role: "owner" })
        .where("org_id", "=", orgId)
        .where("user_id", "=", userId)
        .execute()
      return "owner"
    } catch (err) {
      if (isUniqueViolation(err)) return "agent"
      throw err
    }
  }

  const role = owner ? "agent" : "owner"
  try {
    await db.insertInto("org_members")
      .values({ org_id: orgId, user_id: userId, role })
      .onConflict((oc) => oc.columns(["org_id", "user_id"]).doNothing())
      .execute()
    return role
  } catch (err) {
    // Lost the owner race: someone else claimed the seat between the read
    // and the insert. Agent is the honest answer.
    if (isUniqueViolation(err) && role === "owner") {
      await db.insertInto("org_members")
        .values({ org_id: orgId, user_id: userId, role: "agent" })
        .onConflict((oc) => oc.columns(["org_id", "user_id"]).doNothing())
        .execute()
      return "agent"
    }
    throw err
  }
}

/** Same select-then-insert shape as seedWidgetDemo's origin block: the
 *  allowlist is exact-match, so presence is the only question. */
async function ensureOrigins(orgId: string): Promise<void> {
  for (const origin of DEMO_ORIGINS) {
    const present = await db
      .selectFrom("allowed_origins")
      .select("origin")
      .where("org_id", "=", orgId)
      .where("origin", "=", origin)
      .executeTakeFirst()
    if (!present) {
      await db.insertInto("allowed_origins").values({ org_id: orgId, origin }).execute()
    }
  }
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const org = await db
    .selectFrom("organizations")
    .select(["id", "name"])
    .where("name", "=", ORG_NAME)
    .executeTakeFirst()
  if (!org) {
    console.error(`no organization named "${ORG_NAME}" — run seed-demo in realtime/ first`)
    process.exit(1)
  }

  const { userId, passwordChanged } = await ensureUser()
  const role = await ensureMembership(org.id, userId)
  await ensureOrigins(org.id)

  console.log(`playground login ready: ${EMAIL} (${role} of "${ORG_NAME}")`)
  if (passwordChanged) {
    console.log("note: the account already existed with a different password — sign in with the one you set")
  }
  console.log(`demo-page origins allowlisted: ${DEMO_ORIGINS.join(", ")}`)
  // The machine line the orchestrator's banner parses (playground-core.mjs).
  console.log(`PLAYGROUND_RESULT ${JSON.stringify({ email: EMAIL, role, passwordChanged, orgId: org.id })}`)

  await db.destroy()
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
//#endregion
