//#region Imports
import { WebSocketServer } from "ws"
import type { WebSocket } from "ws"

import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import type { Kysely } from "kysely"

import { newId } from "@shared/utils/ids"
import {
  HANDOFF_HISTORY_LIMIT,
  MAX_HANDOFF_MESSAGE_CHARS,
  TYPING_HINT_INTERVAL_MS,
} from "@shared/handoff/protocol"
import type {
  HandoffHistoryMessage,
  HandoffRole,
  HandoffServerFrame,
} from "@shared/handoff/protocol"

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
 * Since M4.3 an attaching client is also handed the conversation's tail
 * (`replay`) and the room relays typing hints — the two things that make a
 * dropped connection recoverable and a silence legible. Both are additions
 * to this same shape: replay is a bounded read on attach, and typing is a
 * relay that touches no table at all.
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
  /**
   * Live `message` frames held back until this attachment's backlog has been
   * sent (M4.3), then flushed minus anything the backlog already contained.
   * Non-null means "still replaying".
   *
   * The window it covers is small — a claim UPDATE and one indexed SELECT —
   * but it is not empty, and both naive orderings are wrong in it. Reading
   * history BEFORE joining the room LOSES a message committed in between
   * (nobody was in the room to hear the broadcast). Joining first without a
   * buffer DUPLICATES one, or worse delivers it and then has the backlog
   * render over it. Buffering is what makes attach lossless in both
   * directions, and it costs an empty array per connection.
   */
  pending: Extract<HandoffServerFrame, { type: "message" }>[] | null
  /** Last typing state relayed for this attachment, and when — the two
   *  fields the coalescer needs so a per-keystroke client cannot turn into a
   *  per-keystroke broadcast. */
  typing: boolean
  typingRelayedAt: number
}
//#endregion

//#region Constants
const DEFAULT_PATH = "/v1/handoff"
const DEFAULT_HEARTBEAT_MS = 30_000
/**
 * The hard floor between two typing relays from one attachment, whatever
 * they say. The protocol asks well-behaved clients to refresh every
 * TYPING_HINT_INTERVAL_MS and the coalescer already collapses repeats, so
 * this only ever bites a client sending per keystroke or flipping the flag
 * to make noise — and it bites by DROPPING, not by erroring: answering every
 * keystroke with an error frame would be a worse storm than the one being
 * prevented. A state change lost to the floor self-heals within
 * TYPING_TTL_MS, which is exactly what that TTL is for.
 */
const TYPING_FLOOR_MS = 250
//#endregion

//#region Helpers
function send(socket: WebSocket, frame: HandoffServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
}

/** Sends, unless this attachment is still replaying and the frame is a live
 *  message — in which case it queues behind the backlog. See Attachment. */
function deliver(attachment: Attachment, frame: HandoffServerFrame): void {
  if (attachment.pending !== null && frame.type === "message") {
    attachment.pending.push(frame)
    return
  }
  send(attachment.socket, frame)
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
    for (const attachment of this.members(conversationId)) deliver(attachment, frame)
  }

  /** Everyone but one. Used only by typing: a client knows it is composing,
   *  and echoing that back is how a naive client ends up rendering itself as
   *  "someone is typing". Messages deliberately do NOT use this — the sender
   *  seeing its own message through the same broadcast is what gives both
   *  ends one order from one source of truth. */
  broadcastExcept(conversationId: string, except: Attachment, frame: HandoffServerFrame): void {
    for (const attachment of this.members(conversationId)) {
      if (attachment !== except) deliver(attachment, frame)
    }
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
  /** Ends a conversation's room — returns how many sockets were told. */
  endRoom: (conversationId: string) => number
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
          // Buffering starts at construction, before the room join below —
          // there must be no instant in which this attachment is in a room
          // and unable to hold a message back.
          pending: [],
          typing: false,
          typingRelayedAt: 0,
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
    // ready → history → presence, in that order: identity, then what was
    // said, then who is here. Presence waits behind one indexed read, which
    // is a millisecond the other members will not notice and buys every
    // client a deterministic opening sequence.
    await replay(attachment)
    rooms.broadcast(attachment.conversationId, { type: "presence", ...rooms.presence(attachment.conversationId) })

    ws.on("pong", () => { attachment.alive = true })
    ws.on("message", (raw) => {
      // ws RawData is Buffer | ArrayBuffer | Buffer[]; only a plain Buffer
      // stringifies as text. A fragmented or ArrayBuffer frame would decode
      // as comma-joined garbage / "[object ArrayBuffer]" and be blamed on
      // the client's JSON - normalize before parsing.
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Buffer.from(raw).toString("utf8")
      void onFrame(attachment, text)
    })
    ws.on("close", () => {
      rooms.leave(attachment)
      attachments.delete(attachment)
      // Someone who disconnects mid-sentence must not leave their indicator
      // burning on the other end. The receiver's TTL would clear it a few
      // seconds later; saying so immediately is free and exact.
      if (attachment.typing) {
        rooms.broadcastExcept(attachment.conversationId, attachment, {
          type: "typing", role: attachment.role, active: false,
        })
      }
      rooms.broadcast(attachment.conversationId, { type: "presence", ...rooms.presence(attachment.conversationId) })
    })
    ws.on("error", (err) => {
      console.error("[handoff] socket error:", err.message)
    })
  }

  /**
   * Replay on reconnect (M4.3): the conversation's tail, sent once, right
   * after `ready`.
   *
   * The transcript was already complete in Postgres — the dashboard renders
   * it (§9.10) — so this is a read the socket had not been performing, not
   * data it lacked. It reaches back BEFORE the escalation on purpose: what
   * the bot already told this visitor is most of what an arriving agent
   * needs, and a visitor who reloads the page mid-handoff expects their
   * whole exchange, not the half that happened after they asked for a human.
   */
  async function replay(attachment: Attachment): Promise<void> {
    let messages: HandoffHistoryMessage[] = []
    try {
      const rows = await options.db
        .selectFrom("messages")
        .select(["id", "role", "content", "created_at"])
        .where("conversation_id", "=", attachment.conversationId)
        // Newest first, then reversed in memory: the TAIL is what a client
        // needs, and descending is what lets the messages_conversation index
        // (conversation_id, created_at, id) stop after the limit instead of
        // sorting a long thread to throw most of it away. The id tie-break
        // matches the index's own trailing column, so turns written inside
        // one transaction still come back in a stable order.
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(HANDOFF_HISTORY_LIMIT)
        .execute()
      rows.reverse()
      messages = rows.map((row) => ({
        id: row.id,
        role: row.role,
        text: row.content,
        at: row.created_at.toISOString(),
      }))
      send(attachment.socket, { type: "history", messages })
    } catch (err) {
      // A failed read must not cost the client its LIVE conversation. The
      // socket stays open, the buffer below still flushes, and the client is
      // TOLD its backlog is missing rather than left to infer an empty
      // thread from silence.
      console.error("[handoff] history replay failed:", err)
      send(attachment.socket, { type: "error", reason: "history unavailable" })
    }

    // Replay ends the moment the backlog is on the wire (or has failed).
    // Whatever arrived meanwhile goes out now, minus anything the backlog
    // already carried — a message committed inside the window is legally in
    // both, and the client must see it exactly once.
    const buffered = attachment.pending ?? []
    attachment.pending = null
    const replayed = new Set(messages.map((message) => message.id))
    for (const frame of buffered) {
      if (!replayed.has(frame.id)) send(attachment.socket, frame)
    }
  }

  /**
   * Typing, coalesced (M4.3). Nothing is persisted and nothing is echoed to
   * the sender; the only state kept is the last thing this attachment said
   * and when, which is what turns a per-keystroke client into at most one
   * frame per TYPING_HINT_INTERVAL_MS on the wire.
   */
  function relayTyping(attachment: Attachment, active: boolean): void {
    const now = Date.now()
    const sinceLast = now - attachment.typingRelayedAt
    if (sinceLast < TYPING_FLOOR_MS) return
    if (active === attachment.typing) {
      // A repeat earns the wire only when it refreshes a receiver's TTL, and
      // only `true` has a TTL to refresh: nobody's screen changes when "not
      // typing" is said a second time.
      if (!active || sinceLast < TYPING_HINT_INTERVAL_MS) return
    }
    attachment.typing = active
    attachment.typingRelayedAt = now
    rooms.broadcastExcept(attachment.conversationId, attachment, {
      type: "typing",
      // Role from the TICKET, exactly as for a message — the one rule this
      // socket never bends.
      role: attachment.role,
      active,
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
    const frame = parsed as { type?: unknown; text?: unknown; active?: unknown }
    if (frame.type === "typing") {
      // Strict about the flag rather than defaulting it to true: "typing"
      // and "stopped typing" are opposite claims, and guessing which one a
      // malformed frame meant is how an indicator gets stuck.
      if (typeof frame.active !== "boolean") {
        send(attachment.socket, { type: "error", reason: "typing frame needs a boolean 'active'" })
        return
      }
      relayTyping(attachment, frame.active)
      return
    }
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
    let at: Date
    try {
      at = await options.db.transaction().execute(async (trx) => {
        // RETURNING the stored created_at rather than stamping a Date here:
        // the broadcast and the backlog (replay, above) are rendered in ONE
        // list by both clients, so they must agree on when a turn happened.
        // This process and the database are different machines — on Render
        // and Neon respectively — and their clocks can differ by more than
        // the gap between two turns of a fast exchange. Taking Postgres's
        // clock for both makes a reconnecting client's merged thread
        // ordered by construction, and matches the answer pipeline's rows,
        // which take the column default.
        const inserted = await trx.insertInto("messages").values({
          id,
          conversation_id: attachment.conversationId,
          org_id: attachment.orgId,
          // The role comes from the TICKET, never from the frame — a client
          // that could name its own role could impersonate an agent.
          role: attachment.role,
          content: text,
        }).returning("created_at").executeTakeFirstOrThrow()
        await trx.updateTable("conversations")
          .set({ last_message_at: inserted.created_at })
          .where("id", "=", attachment.conversationId)
          .execute()
        return inserted.created_at
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

    // Sending a message ends composing by definition. Clearing here rather
    // than waiting for the client's own `typing:false` means an indicator can
    // never outlive the sentence it was announcing, and this path bypasses
    // the relay floor deliberately: unlike a keystroke, a sent message
    // already cost a transaction, so it cannot be used to make noise.
    if (attachment.typing) {
      attachment.typing = false
      attachment.typingRelayedAt = Date.now()
      rooms.broadcastExcept(attachment.conversationId, attachment, {
        type: "typing", role: attachment.role, active: false,
      })
    }
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
    /**
     * Tell a conversation's room it is over, then hang up (M4.6). Called by
     * the internal close route, in THIS process, which is why the close
     * lives behind realtime rather than being a direct write from the
     * dashboard: the rooms are in memory here (§3.24's honest limit), so the
     * write and the notification have to happen in the same place — the same
     * argument that makes the ingest enqueue wake the worker (§3.22).
     *
     * The frame goes first and the socket closes after: a client that only
     * saw the disconnect would spend a reconnect and a ticket mint to learn
     * what one frame already said, and would show "reconnecting" meanwhile.
     */
    endRoom: (conversationId: string) => {
      const members = rooms.members(conversationId)
      for (const attachment of members) {
        send(attachment.socket, { type: "closed" })
        attachment.socket.close()
      }
      return members.length
    },
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
