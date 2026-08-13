"use server"

//#region Server Actions
// The agent's key to the handoff socket (M4.5). One action, called once per
// CONNECTION ATTEMPT — tickets are single-use and expire in 60 seconds
// (§3.24), so the client component calls this again on every reconnect
// rather than holding anything.
//
// Trust ladder, one rung shorter than providers/sources: signed-in →
// member, with no owner check. Answering a waiting visitor IS the agent
// role (the same reason §9.10's transcript is readable by agents), and an
// inbox only owners could work would make the role pointless.
//
// The ladder is not decoration: a Server Action is reachable as a direct
// POST, not only through this UI, so authorization belongs INSIDE it —
// Next's own docs say so, and realtime checks membership again anyway.
//#endregion

//#region Imports
import { currentUser } from "@/lib/auth/requireUser"
import { getOrgForMember } from "@/lib/orgs"
import { mintHandoffTicket } from "@/lib/realtime"
//#endregion

//#region Types
export type TicketResult =
  | { ok: true; ticket: string }
  | { ok: false; error: string }
//#endregion

//#region Actions
export async function requestHandoffTicketAction(
  orgId: string,
  conversationId: string,
): Promise<TicketResult> {
  const user = await currentUser()
  if (!user) {
    return { ok: false, error: "Your session expired — sign in again." }
  }
  const org = await getOrgForMember(orgId, user.id)
  if (!org) {
    // Same shape a non-member and a fabricated org id both get everywhere
    // else in the dashboard: which one it was is not information to leak.
    return { ok: false, error: "Conversation not found." }
  }

  const result = await mintHandoffTicket(orgId, conversationId, user.id)
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  return { ok: true, ticket: result.value.ticket }
}
//#endregion
