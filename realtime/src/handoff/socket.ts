//#region Imports
import { WebSocketServer } from "ws"
import type { WebSocket } from "ws"

import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import type { Kysely } from "kysely"

import { newId } from "@shared/utils/ids"
import { MAX_HANDOFF_MESSAGE_CHARS } from "@shared/handoff/protocol"
import type { HandoffRole, HandoffServerFrame } from "@shared/handoff/protocol"

import type { Database } from "@/db/schema"
import { TicketRegistry, verifyHandoffTicket } from "@/handoff/ticket"
//#endregion

//#region Type Defs
/**
 * The handoff WebSocket server (M4.2): the two-way channel a visitor and an
 * agent share once a conversation has been escalated (§3.23).
 *
 * `noServer: true` and a hand-written upgrade handler, deliberately. The ws
 * library will happily attach itself to an http server and authenticate
 * afterwards, in the connection handler — and that is the wrong shape: it
 * completes a handshake for an unauthenticated party, which means a
 * connection exists, consumes a slot, and can send frames before anyone has
 * checked who it is. Here the ticket is verified and SPENT before
 * handleUpgrade is called at all, so an unauthenticated socket is never a
 * WebSocket in the first place; it is a TCP connection that gets an HTTP
 * error and a FIN. That is the identity-at-upgrade pattern the plan names.
 *
 * Rooms are in memory, keyed by conversation. Single always-on instance by
 * design (§3.17.2's argument, and Render's free tier), so this is correct
 * today; the honest limit is that a SECOND instance would need the rooms
 * (and the consumed-ticket set) in a shared store, because two visitors of
 * one conversation landing on different instances would not hear each
 * other. It is the one place in this codebase where a second instance is
 * more than a deploy, and the README says so rather than implying
 * otherwise.
 */
interface HandoffServerOptions {
  db: Kysely<Database>
  /** The widget token secret; the ticket key is derived from it. */
  ticketSecret: string
  /** Injectable so tests can drive replay and expiry deterministically. */
  tickets?: TicketRegistry
  /** Upgrade path. One path, one protocol — anything else gets a 404. */
  path?: string
  /**
   * Ping period. Half-open sockets (a laptop lid closing, a NAT dropping
   * state) never fire 'close', so without this a phantom agent would show
   * as present forever and the visitor would wait for someone who left.
   * 0 disables the timer, which is what tests want.
   */
  heartbeatMs?: number
}

interface Attachment {
  socket: WebSocket
  conversationId: string
  orgId: string
  role: HandoffRole
  /** Visitor id or dashboard user id — from the TICKET, never from a frame. */
  subject: string
  alive: boolean
}
//#endregion

//#region Constants
const DEFAULT_PATH = "/v1/handoff"
const DEFAULT_HEARTBEAT_MS = 30_000
//#endregion

//#region Helpers
function send(socket: WebSocket, frame: HandoffServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
}

/** Refuses an upgrade the way HTTP does — a status line and a FIN. The
 *  browser surfaces this to the page as a failed connection, which is all a
 *  rejected client is entitled to know. */
function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
//#endregion

//#region Rooms
/** Everyone attached to one conversation. A Set per room rather than a
 *  flat list: join/leave are O(1) and a socket can never double-join. */
class Rooms {
  readonly #byConversation = new Map<string, Set<Attachment>>()

  join(attachment: Attachment): void {
    const existing = this.#byConversation.get(attachment.conversationId)
    if (existing) existing.add(attachment)
    else this.#byConversation.set(attachment.conversationId, new Set([attachment]))
  }

  leave(attachment: Attachment): void {
    const room = this.#byConversation.get(attachment.conversationId)
    if (!room) return
    room.delete(attachment)
    // Empty rooms are deleted, not kept: the map must not grow with every
    // conversation the service has ever seen.
    if (room.size === 0) this.#byConversation.delete(attachment.conversationId)
  }

  members(conversationId: string): Attachment[] {
    return [...(this.#byConversation.get(conversationId) ?? [])]
  }

  broadcast(conversationId: string, frame: HandoffServerFrame): void {
    for (const attachment of this.members(conversationId)) send(attachment.socket, frame)
  }

  presence(conversationId: string): { agents: number; visitors: number } {
    let agents = 0
    let visitors = 0
    for (const attachment of this.members(conversationId)) {
      if (attachment.role === "agent") agents++
      else visitors++
    }
    return { agents, visitors }
  }

  get size(): number {
    let total = 0
    for (const room of this.#byConversation.values()) total += room.size
    return total
  }
}
//#endregion

//#region Server
function createHandoffServer(options: HandoffServerOptions): {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  close: () => Promise<void>
  readonly attached: number
} {
  const path = options.path ?? DEFAULT_PATH
  const tickets = options.tickets ?? new TicketRegistry()
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const rooms = new Rooms()
  /** Every live attachment, for the heartbeat sweep. Rooms indexes by
   *  conversation; this is the flat set the timer walks. */
  const attachments = new Set<Attachment>()
  // maxPayload bounds a frame at the protocol cap with generous headroom
  // for JSON escaping — a client cannot make the server buffer megabytes
  // before the length check in onFrame ever runs.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_HANDOFF_MESSAGE_CHARS * 4 })

  //#region Upgrade
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Errors here must never leave a socket dangling: an upgrade that
    // throws would otherwise hold a file descriptor until the OS times it
    // out.
    void (async () => {
      let url: URL
      try {
        url = new URL(req.url ?? "/", "http://placeholder")
      } catch {
        refuse(socket, 400, "Bad Request")
        return
      }
      if (url.pathname !== path) {
        refuse(socket, 404, "Not Found")
        return
      }

      const ticket = url.searchParams.get("ticket")
      const payload = ticket !== null ? verifyHandoffTicket(ticket, options.ticketSecret) : null
      if (payload === null) {
        refuse(socket, 401, "Unauthorized")
        return
      }
      // Spent HERE, before any database work: a replayed ticket must cost
      // the same as a forged one.
      if (!tickets.consume(payload.jti, payload.exp)) {
        refuse(socket, 401, "Unauthorized")
        return
      }

      // The ticket says who; the database says whether there is still
      // anything to join. A handoff closed in the seconds since minting
      // means the conversation is the bot's again.
      const row = await options.db
        .selectFrom("handoff_sessions")
        .innerJoin("conversations", "conversations.id", "handoff_sessions.conversation_id")
        .select([
          "handoff_sessions.id as handoff_id",
          "handoff_sessions.status as status",
          "conversations.org_id as org_id",
          "conversations.visitor_id as visitor_id",
        ])
        .where("handoff_sessions.conversation_id", "=", payload.con)
        .where("handoff_sessions.status", "!=", "closed")
        .executeTakeFirst()
      if (!row || row.org_id !== payload.org) {
        refuse(socket, 404, "Not Found")
        return
      }
      // A visitor ticket only opens ITS OWN conversation. (An agent's
      // membership was checked when the ticket was minted — the internal
      // API is the only thing that can mint one.)
      if (payload.role === "visitor" && row.visitor_id !== payload.sub) {
        refuse(socket, 404, "Not Found")
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        void onConnection(ws, {
          socket: ws,
          conversationId: payload.con,
          orgId: payload.org,
          role: payload.role,
          subject: payload.sub,
          alive: true,
        }, row.handoff_id, row.status)
      })
    })().catch((err) => {
      console.error("[handoff] upgrade failed:", err)
      refuse(socket, 500, "Internal Server Error")
    })
  }
  //#endregion

  //#region Connection lifecycle
  async function onConnection(
    ws: WebSocket,
    attachment: Attachment,
    handoffId: string,
    status: "pending" | "active" | "closed",
  ): Promise<void> {
    rooms.join(attachment)
    attachments.add(attachment)

    // An agent ATTACHING is what claims the handoff — presence is the
    // product meaning of "active", so there is no separate claim button to
    // forget to press. Guarded on status='pending' in SQL, so two agents
    // arriving together produce one claim and one extra participant rather
    // than a lost update.
    let currentStatus: "pending" | "active" = status === "active" ? "active" : "pending"
    if (attachment.role === "agent" && currentStatus === "pending") {
      await options.db
        .updateTable("handoff_sessions")
        .set({ status: "active", claimed_by: attachment.subject, claimed_at: new Date() })
        .where("id", "=", handoffId)
        .where("status", "=", "pending")
        .execute()
      // Claimed by us, or by another agent in the same instant — either way
      // a person is here now, which is the only thing the visitor is told.
      currentStatus = "active"
    }

    send(ws, {
      type: "ready",
      role: attachment.role,
      conversationId: attachment.conversationId,
      status: currentStatus,
    })
    rooms.broadcast(attachment.conversationId, { type: "presence", ...rooms.presence(attachment.conversationId) })

    ws.on("pong", () => { attachment.alive = true })
    ws.on("message", (raw) => { void onFrame(attachment, raw.toString()) })
    ws.on("close", () => {
      rooms.leave(attachment)
      attachments.delete(attachment)
      rooms.broadcast(attachment.conversationId, { type: "presence", ...rooms.presence(attachment.conversationId) })
    })
    ws.on("error", (err) => {
      console.error("[handoff] socket error:", err.message)
    })
  }

  async function onFrame(attachment: Attachment, raw: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      send(attachment.socket, { type: "error", reason: "frame was not JSON" })
      return
    }
    const frame = parsed as { type?: unknown; text?: unknown }
    if (frame.type !== "message" || typeof frame.text !== "string") {
      send(attachment.socket, { type: "error", reason: "unsupported frame" })
      return
    }
    const text = frame.text.trim()
    if (text.length === 0 || text.length > MAX_HANDOFF_MESSAGE_CHARS) {
      send(attachment.socket, { type: "error", reason: `message must be 1-${MAX_HANDOFF_MESSAGE_CHARS} characters` })
      return
    }

    // Persisted BEFORE broadcast: a message the other side saw but the
    // transcript never recorded is worse than a slow one, and the
    // dashboard's transcript view (§9.10) is the record of what was said.
    const id = newId("msg")
    const at = new Date()
    try {
      await options.db.transaction().execute(async (trx) => {
        await trx.insertInto("messages").values({
          id,
          conversation_id: attachment.conversationId,
          org_id: attachment.orgId,
          // The role comes from the TICKET, never from the frame — a client
          // that could name its own role could impersonate an agent.
          role: attachment.role,
          content: text,
        }).execute()
        await trx.updateTable("conversations")
          .set({ last_message_at: at })
          .where("id", "=", attachment.conversationId)
          .execute()
      })
    } catch (err) {
      console.error("[handoff] message persist failed:", err)
      send(attachment.socket, { type: "error", reason: "message could not be delivered" })
      return
    }

    rooms.broadcast(attachment.conversationId, {
      type: "message",
      id,
      role: attachment.role,
      text,
      at: at.toISOString(),
    })
  }
  //#endregion

  //#region Heartbeat
  // Ping every attachment; anything that did not pong since the last round
  // is gone and gets terminated, which fires 'close' and cleans up presence
  // through the ordinary path. Liveness lives on the Attachment rather than
  // on a property bolted to the ws object — the same object the library
  // owns — so there is one place that knows what a connection is.
  const timer = heartbeatMs > 0
    ? setInterval(() => {
        for (const attachment of attachments) {
          if (!attachment.alive) {
            attachment.socket.terminate()
            continue
          }
          attachment.alive = false
          attachment.socket.ping()
        }
      }, heartbeatMs)
    : null
  // unref so a live heartbeat never holds the process open during shutdown.
  timer?.unref()
  //#endregion

  return {
    handleUpgrade,
    close: async () => {
      if (timer !== null) clearInterval(timer)
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
    get attached() {
      return rooms.size
    },
  }
}
//#endregion

//#region Exports
export { createHandoffServer, DEFAULT_PATH as HANDOFF_PATH }
export type { HandoffServerOptions }
//#endregion
