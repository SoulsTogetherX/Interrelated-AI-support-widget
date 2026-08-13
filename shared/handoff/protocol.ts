//#region Type Defs
/**
 * The handoff socket's wire protocol (M4.2) — what travels once a
 * conversation has become a person's (shared/grounding/events.ts carries
 * the BOT's answers; this carries the human's). In shared/ because three
 * packages speak it: realtime produces and consumes, the widget is the
 * visitor end, and the dashboard is the agent end.
 *
 * Deliberately tiny and symmetric. Both ends send the same frames — a
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
  /**
   * "I am (or am no longer) composing." (M4.3) Advisory and EPHEMERAL: never
   * persisted, never replayed, and never echoed to the sender — a client
   * knows it is typing, and the transcript is the record of what was SAID,
   * not of what someone nearly said. A client that keeps typing re-sends
   * `active: true` every TYPING_HINT_INTERVAL_MS; the server coalesces
   * repeats, so a naive per-keystroke client costs the room nothing.
   */
  | { type: "typing"; active: boolean }

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
  /**
   * The backlog, sent once, immediately after `ready` (M4.3). A client that
   * reconnects — a reloaded page, a phone leaving a tunnel — attaches to a
   * live room but has nothing in it; this is the read that fills it.
   *
   * A SEPARATE frame from `message` on purpose: a replayed message is not a
   * new event. A client that received these as `message` frames would
   * double-render everything it already had, and would ring a notification
   * for prose from an hour ago. One `history` frame is something a client
   * can RENDER OVER its thread rather than append to.
   *
   * Bounded at HANDOFF_HISTORY_LIMIT: a socket handshake must not turn into
   * an unbounded transcript download, and the dashboard already has the full
   * record over HTTP (CLAUDE.md §9.10).
   */
  | { type: "history"; messages: HandoffHistoryMessage[] }
  /** One message, from either side, broadcast to everyone attached —
   *  including the sender, so a client never has to guess whether its own
   *  message landed and can render one source of truth in one order. */
  | { type: "message"; id: string; role: HandoffRole; text: string; at: string }
  /** Who else is attached. The visitor's widget turns `agents > 0` into
   *  "you're talking to a person" and `0` into "waiting for someone" —
   *  which is why presence is a COUNT and not a name: a support agent's
   *  identity is the tenant's to disclose, not ours. */
  | { type: "presence"; agents: number; visitors: number }
  /** Somebody ELSE is composing (M4.3). By role, not by identity, for the
   *  same reason presence is a count. Self-expiring by contract: a receiver
   *  drops the indicator after TYPING_TTL_MS without a refresh, so a socket
   *  that dies mid-sentence cannot leave "an agent is typing…" on screen
   *  forever — the same phantom-participant problem the heartbeat solves for
   *  presence, solved here without server state. */
  | { type: "typing"; role: HandoffRole; active: boolean }
  /** A frame was refused (malformed, too long, or sent to a conversation
   *  that has since closed). Carries a short reason because BOTH ends of
   *  this socket are authenticated parties — unlike the public SSE stream,
   *  where an opaque error is the right call. */
  | { type: "error"; reason: string }

type HandoffRole = "visitor" | "agent"

/** Who a replayed message is from. Wider than HandoffRole because the
 *  backlog reaches back BEFORE the escalation: the bot's answers are most of
 *  what a joining agent needs to read, and re-labelling them as anything
 *  else would misattribute them. Matches messages.role in the schema. */
type HandoffTranscriptRole = HandoffRole | "assistant"

/** One replayed turn. `text` is messages.content — what the visitor actually
 *  SAW (verified claims after stripping, or the refusal), never raw model
 *  output; the claim-level verdicts stay in the dashboard's transcript view,
 *  which is where a tenant audits them. */
interface HandoffHistoryMessage {
  id: string
  role: HandoffTranscriptRole
  text: string
  /** ISO 8601, from messages.created_at. */
  at: string
}
//#endregion

//#region Constants
/** Cap on one message. Generous for support prose, small enough that a
 *  socket cannot be used to push a payload — the HTTP surface caps bodies
 *  at 64 KB and this is the socket's equivalent. */
const MAX_HANDOFF_MESSAGE_CHARS = 4_000

/** Turns replayed on attach. Fifty is several screens of support
 *  conversation and a few KB on the wire — enough that a reconnecting
 *  visitor sees their whole exchange, bounded enough that a long-running
 *  thread cannot make every upgrade expensive. */
const HANDOFF_HISTORY_LIMIT = 50

/** How often a client that is STILL typing re-asserts it. The receiver's TTL
 *  is the thing being refreshed. */
const TYPING_HINT_INTERVAL_MS = 2_000

/** How long a receiver holds a typing indicator without a refresh. Comfortably
 *  more than twice the hint interval, so one dropped or throttled frame makes
 *  the indicator flicker rather than making it lie. */
const TYPING_TTL_MS = 6_000
//#endregion

//#region Exports
export { MAX_HANDOFF_MESSAGE_CHARS, HANDOFF_HISTORY_LIMIT, TYPING_HINT_INTERVAL_MS, TYPING_TTL_MS }
export type {
  HandoffClientFrame,
  HandoffServerFrame,
  HandoffRole,
  HandoffTranscriptRole,
  HandoffHistoryMessage,
}
//#endregion
