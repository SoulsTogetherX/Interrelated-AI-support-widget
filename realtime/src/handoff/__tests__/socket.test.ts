//#region Imports
import { createServer } from "node:http"
import type { Server } from "node:http"

import WebSocket from "ws"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { requestHandoff } from "@/handoff/escalate"
import { createHandoffServer } from "@/handoff/socket"
import { mintHandoffTicket, TicketRegistry } from "@/handoff/ticket"
import { newId } from "@shared/utils/ids"
import type { HandoffServerFrame } from "@shared/handoff/protocol"
//#endregion

//#region Test Setup
// The handoff socket end to end: a real http listener, real ws clients, and
// real Postgres. Nothing is stubbed except the clock-free bits — the point
// of this suite is the UPGRADE path (which a unit test cannot exercise) and
// the two-way relay it protects.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)
const SECRET = "handoff-socket-test-secret-0123456789ab"

let server: Server
let wsBase: string
let handoff: ReturnType<typeof createHandoffServer>
let orgId: string
let agentId: string

/** Everything a test needs to talk on one conversation. */
async function escalatedConversation(visitorId: string): Promise<string> {
  const conversationId = newId("con")
  await db.insertInto("conversations")
    .values({ id: conversationId, org_id: orgId, visitor_id: visitorId })
    .execute()
  const outcome = await requestHandoff(db, {
    orgId, conversationId, visitorId, reason: "visitor_request",
  })
  if (!outcome.ok) throw new Error("fixture failed to escalate")
  return conversationId
}

function ticketFor(
  conversationId: string,
  role: "visitor" | "agent",
  sub: string,
  org = orgId,
): string {
  return mintHandoffTicket({ con: conversationId, org, role, sub }, SECRET).ticket
}

/** A connected client with a frame queue — `next()` awaits the next frame,
 *  so tests read the conversation in order instead of sleeping. */
interface Client {
  socket: WebSocket
  next(): Promise<HandoffServerFrame>
  send(frame: unknown): void
  close(): Promise<void>
}

function connect(ticket: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}/v1/handoff?ticket=${encodeURIComponent(ticket)}`)
    const queue: HandoffServerFrame[] = []
    let waiting: ((frame: HandoffServerFrame) => void) | null = null

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as HandoffServerFrame
      if (waiting) { const w = waiting; waiting = null; w(frame) }
      else queue.push(frame)
    })
    socket.on("error", reject)
    socket.on("unexpected-response", (_req, res) => {
      reject(new Error(`upgrade refused: ${res.statusCode}`))
    })
    socket.on("open", () => {
      resolve({
        socket,
        next: () => new Promise<HandoffServerFrame>((r) => {
          const queued = queue.shift()
          if (queued) r(queued)
          else waiting = r
        }),
        send: (frame: unknown) => socket.send(JSON.stringify(frame)),
        close: () => new Promise<void>((r) => { socket.once("close", () => r()); socket.close() }),
      })
    })
  })
}

/** The status code an upgrade was refused with — what a rejected client
 *  actually observes. */
function refusalStatus(ticket: string, path = "/v1/handoff"): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${path}?ticket=${encodeURIComponent(ticket)}`)
    socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0))
    socket.on("open", () => { socket.close(); reject(new Error("upgrade unexpectedly succeeded")) })
    socket.on("error", (err) => reject(err))
  })
}
//#endregion

describe.skipIf(!DB_CONFIGURED)("handoff socket", () => {
  beforeAll(async () => {
    await migrateToLatest(db)
    orgId = newId("org")
    agentId = newId("usr")
    await db.insertInto("organizations").values({ id: orgId, name: "Socket Co" }).execute()
    await db.insertInto("users").values({
      id: agentId, email_index: `idx_${agentId}`, email_ciphertext: "x", password_hash: "x",
    }).execute()

    // heartbeatMs 0: no timer in the test process. The heartbeat's job is
    // reaping half-open sockets, which a loopback test cannot produce.
    handoff = createHandoffServer({ db, ticketSecret: SECRET, tickets: new TicketRegistry(), heartbeatMs: 0 })
    server = createServer((_req, res) => { res.writeHead(426).end() })
    server.on("upgrade", (req, socket, head) => handoff.handleUpgrade(req, socket, head))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const address = server.address() as { port: number }
    wsBase = `ws://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await handoff.close()
    await new Promise((r) => server.close(r))
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await db.deleteFrom("users").where("id", "=", agentId).execute()
    await db.destroy()
  })

  //#region The upgrade boundary
  it("refuses an upgrade with no ticket, a forged one, or the wrong path", async () => {
    await expect(refusalStatus("")).resolves.toBe(401)
    await expect(refusalStatus("garbage")).resolves.toBe(401)
    const conversationId = await escalatedConversation("vis_path")
    const valid = ticketFor(conversationId, "visitor", "vis_path")
    await expect(refusalStatus(valid, "/v1/not-handoff")).resolves.toBe(404)
  })

  it("refuses a REPLAYED ticket — the URL it rode in is not a credential", async () => {
    const conversationId = await escalatedConversation("vis_replay")
    const ticket = ticketFor(conversationId, "visitor", "vis_replay")

    const first = await connect(ticket)
    expect((await first.next()).type).toBe("ready")
    await first.close()

    // Same ticket, seconds later, still unexpired — and worthless.
    await expect(refusalStatus(ticket)).resolves.toBe(401)
  })

  it("refuses a ticket for another org, another visitor, or a closed handoff", async () => {
    const conversationId = await escalatedConversation("vis_owner")

    // Right conversation, wrong tenant.
    await expect(refusalStatus(ticketFor(conversationId, "visitor", "vis_owner", newId("org"))))
      .resolves.toBe(404)
    // Right tenant, wrong visitor — the binding that stops one visitor
    // listening to another's conversation with staff.
    await expect(refusalStatus(ticketFor(conversationId, "visitor", "vis_someone_else")))
      .resolves.toBe(404)

    // And once the handoff closes there is nothing to join.
    const closed = await escalatedConversation("vis_closed")
    await db.updateTable("handoff_sessions")
      .set({ status: "closed", closed_at: new Date() })
      .where("conversation_id", "=", closed)
      .execute()
    await expect(refusalStatus(ticketFor(closed, "visitor", "vis_closed"))).resolves.toBe(404)
  })
  //#endregion

  //#region Presence and claiming
  it("an agent attaching CLAIMS the handoff, and both sides see the presence", async () => {
    const conversationId = await escalatedConversation("vis_claim")
    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_claim"))

    const ready = await visitor.next()
    expect(ready).toEqual({ type: "ready", role: "visitor", conversationId, status: "pending" })
    expect(await visitor.next()).toEqual({ type: "presence", agents: 0, visitors: 1 })

    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    // The agent's own ready says active — attaching IS claiming, so there
    // is no separate button to forget to press.
    expect(await agent.next()).toEqual({ type: "ready", role: "agent", conversationId, status: "active" })
    // …and the visitor learns a person is here.
    expect(await visitor.next()).toEqual({ type: "presence", agents: 1, visitors: 1 })

    const row = await db.selectFrom("handoff_sessions").selectAll()
      .where("conversation_id", "=", conversationId).executeTakeFirstOrThrow()
    expect(row.status).toBe("active")
    expect(row.claimed_by).toBe(agentId)
    expect(row.claimed_at).not.toBeNull()

    await agent.close()
    // Leaving is presence too — otherwise the visitor waits for someone
    // who has gone.
    expect(await visitor.next()).toEqual({ type: "presence", agents: 0, visitors: 1 })
    await visitor.close()
  })
  //#endregion

  //#region The relay
  it("relays both ways, persists every message, and attributes roles from the TICKET", async () => {
    const conversationId = await escalatedConversation("vis_relay")
    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_relay"))
    await visitor.next() // ready
    await visitor.next() // presence
    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    await agent.next()   // ready
    await agent.next()   // presence
    await visitor.next() // presence (agent joined)

    // A client cannot name its own role: this frame CLAIMS to be an agent.
    visitor.send({ type: "message", text: "my order never arrived", role: "agent" })
    const heardByAgent = await agent.next()
    const echoedToVisitor = await visitor.next()
    expect(heardByAgent).toMatchObject({ type: "message", role: "visitor", text: "my order never arrived" })
    // The sender sees its own message through the same broadcast, so both
    // ends render one order from one source of truth.
    expect(echoedToVisitor).toEqual(heardByAgent)

    agent.send({ type: "message", text: "I can see it — reshipping now." })
    expect(await visitor.next()).toMatchObject({ type: "message", role: "agent", text: "I can see it — reshipping now." })
    await agent.next()

    // Persisted, in order, with the roles the tickets said.
    const rows = await db.selectFrom("messages").selectAll()
      .where("conversation_id", "=", conversationId).orderBy("created_at").orderBy("id").execute()
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ["visitor", "my order never arrived"],
      ["agent", "I can see it — reshipping now."],
    ])
    // Agent messages carry no model/refused/latency — the schema CHECKs
    // reserve those for the assistant role, and a human is not one.
    expect(rows.every((r) => r.model === null && r.refused === false)).toBe(true)
    // The thread rose to the top of the dashboard's list.
    const conversation = await db.selectFrom("conversations").selectAll()
      .where("id", "=", conversationId).executeTakeFirstOrThrow()
    expect(conversation.last_message_at.getTime()).toBeGreaterThan(conversation.created_at.getTime() - 1)

    await visitor.close()
    await agent.close()
  })

  it("rejects malformed frames and oversized messages without dropping the socket", async () => {
    const conversationId = await escalatedConversation("vis_frames")
    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_frames"))
    await visitor.next() // ready
    await visitor.next() // presence

    visitor.socket.send("not json at all")
    expect(await visitor.next()).toMatchObject({ type: "error", reason: expect.stringContaining("JSON") })

    visitor.send({ type: "typing" })
    expect(await visitor.next()).toMatchObject({ type: "error", reason: "unsupported frame" })

    visitor.send({ type: "message", text: "   " })
    expect((await visitor.next()).type).toBe("error")

    visitor.send({ type: "message", text: "x".repeat(4_001) })
    expect((await visitor.next()).type).toBe("error")

    // Still usable: a bad frame is not a reason to hang up on a visitor
    // mid-support-conversation.
    visitor.send({ type: "message", text: "sorry, hello?" })
    expect(await visitor.next()).toMatchObject({ type: "message", text: "sorry, hello?" })
    expect(await db.selectFrom("messages").selectAll()
      .where("conversation_id", "=", conversationId).execute()).toHaveLength(1)

    await visitor.close()
  })

  it("keeps conversations apart — a message reaches only its own room", async () => {
    const alpha = await escalatedConversation("vis_alpha")
    const beta = await escalatedConversation("vis_beta")
    const inAlpha = await connect(ticketFor(alpha, "visitor", "vis_alpha"))
    const inBeta = await connect(ticketFor(beta, "visitor", "vis_beta"))
    await inAlpha.next(); await inAlpha.next()
    await inBeta.next(); await inBeta.next()

    inAlpha.send({ type: "message", text: "alpha only" })
    expect(await inAlpha.next()).toMatchObject({ text: "alpha only" })

    // Beta's next frame must be beta's own message, never alpha's — the
    // cross-tenant leak this room registry exists to prevent.
    inBeta.send({ type: "message", text: "beta only" })
    expect(await inBeta.next()).toMatchObject({ text: "beta only" })

    await inAlpha.close()
    await inBeta.close()
  })
  //#endregion
})

describe.skipIf(DB_CONFIGURED)("handoff socket (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})
