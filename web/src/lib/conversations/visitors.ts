//#region Why this file
// How the dashboard names the other party in a conversation. Two kinds of
// visitor share `conversations.visitor_id` (shared/utils/visitorIds.ts):
// anonymous ones the browser minted (vis_<hex>, meaningless to a human, so
// shown truncated) and IDENTIFIED ones the tenant's own server minted with
// the secret key (their user id, meaningful to them, so shown whole). The
// classification is by shape, and it is TRUSTWORTHY by construction rather
// than by convention: realtime's browser mint refuses anything but the
// anonymous shape, so a non-anonymous id can only have entered a session
// token through POST /v1/sessions — which required the org's secret key.
// That is what lets an agent read "user 42 — identified by your server" and
// act on it.
//#endregion

//#region Imports
import { isAnonymousVisitorId } from "@shared/utils/visitorIds"
//#endregion

//#region Types
export interface VisitorDescription {
  /** "visitor" for an anonymous id, "user" for one the tenant's server asserted. */
  noun: "visitor" | "user"
  /** What to print after the noun: the id, truncated when it is a random
   *  handle nobody will recognize, whole when it is the tenant's own. */
  name: string
  identified: boolean
}
//#endregion

//#region Exports
/** Truncation for anonymous handles matches what the pages showed before
 *  identity existed: twelve characters and an ellipsis. */
const ANONYMOUS_SHOWN_CHARS = 12

export function describeVisitor(visitorId: string): VisitorDescription {
  if (isAnonymousVisitorId(visitorId)) {
    return {
      noun: "visitor",
      name: `${visitorId.slice(0, ANONYMOUS_SHOWN_CHARS)}…`,
      identified: false,
    }
  }
  return { noun: "user", name: visitorId, identified: true }
}

/** The suffix that says WHY the dashboard trusts the name — appended
 *  wherever an identified visitor is named in full. */
export const IDENTIFIED_SUFFIX = " — identified by your server"
//#endregion
