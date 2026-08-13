//#region Type Defs
/**
 * The handoff socket's wire protocol (M4.2) — what travels once a
 * conversation has become a person's (shared/grounding/events.ts carries
 * the BOT's answers; this carries the human's). In shared/ because three
 * packages speak it: realtime produces and consumes, the widget is the
 * visitor end, and the dashboard is the agent end.
 *
 * Deliberately tiny and symmetric. Both ends send the same frame — a
 * message is a message — and the server is what knows who is talking; a
 * client that could DECLARE its own role would be a client that could
 * impersonate an agent, so role is never an input, only an output.
 *
 * JSON text frames, not a binary protocol: the payload is short prose, the
 * volume is human-typing-speed, and a debuggable wire is worth more here
 * than bytes. Every frame carries `type` first so a switch is exhaustive.
 */

/** Client → server. */
type HandoffClientFrame =
  /** Say something in this conversation. The server assigns the id, the
   *  role, and the timestamp — none of the three are the client's to pick. */
  | { type: "message"; text: string }

/** Server → client. */
type HandoffServerFrame =
  /** First frame after a successful upgrade: who the server thinks you
   *  are and what state the handoff is in. A client that never receives
   *  this did not authenticate. */
  | {
      type: "ready"
      role: HandoffRole
      conversationId: string
      status: "pending" | "active"
    }
  /** One message, from either side, broadcast to everyone attached —
   *  including the sender, so a client never has to guess whether its own
   *  message landed and can render one source of truth in one order. */
  | { type: "message"; id: string; role: HandoffRole; text: string; at: string }
  /** Who else is attached. The visitor's widget turns `agents > 0` into
   *  "you're talking to a person" and `0` into "waiting for someone" —
   *  which is why presence is a COUNT and not a name: a support agent's
   *  identity is the tenant's to disclose, not ours. */
  | { type: "presence"; agents: number; visitors: number }
  /** A frame was refused (malformed, too long, or sent to a conversation
   *  that has since closed). Carries a short reason because BOTH ends of
   *  this socket are authenticated parties — unlike the public SSE stream,
   *  where an opaque error is the right call. */
  | { type: "error"; reason: string }

type HandoffRole = "visitor" | "agent"

/** Cap on one message. Generous for support prose, small enough that a
 *  socket cannot be used to push a payload — the HTTP surface caps bodies
 *  at 64 KB and this is the socket's equivalent. */
const MAX_HANDOFF_MESSAGE_CHARS = 4_000
//#endregion

//#region Exports
export { MAX_HANDOFF_MESSAGE_CHARS }
export type { HandoffClientFrame, HandoffServerFrame, HandoffRole }
//#endregion
