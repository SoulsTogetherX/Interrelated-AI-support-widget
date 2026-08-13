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
import { HANDOFF_HISTORY_LIMIT } from "@shared/handoff/protocol"
import type { HandoffHistoryMessage, HandoffServerFrame } from "@shared/handoff/protocol"
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

/** Fails loudly instead of hanging on a frame that never comes — a lost
 *  message should read as a lost message, not as a suite timeout. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
    timer.unref()
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * Consumes the opening sequence every attachment gets — ready, then the
 * backlog, then presence — and hands back everything the client was told had
 * already been said. Pinning the order HERE means every test that merely
 * wants a connected client also pins it.
 *
 * Messages that landed while the backlog was being read are flushed between
 * history and presence, so they are collected too — and checked against the
 * backlog's ids, which is the once-and-only-once contract asserted for every
 * connection in the suite rather than only in the test that races it.
 */
async function open(client: Client): Promise<HandoffHistoryMessage[]> {
  const ready = await within(client.next(), 5_000, "ready")
  if (ready.type !== "ready") throw new Error(`expected ready, got ${ready.type}`)
  const history = await within(client.next(), 5_000, "history")
  if (history.type !== "history") throw new Error(`expected history, got ${history.type}`)

  const ids = new Set(history.messages.map((message) => message.id))
  const flushed: HandoffHistoryMessage[] = []
  let frame = await within(client.next(), 5_000, "presence")
  while (frame.type === "message") {
    if (ids.has(frame.id)) throw new Error(`message ${frame.id} arrived twice: backlog and live`)
    ids.add(frame.id)
    flushed.push({ id: frame.id, role: frame.role, text: frame.text, at: frame.at })
    frame = await within(client.next(), 5_000, "presence")
  }
  if (frame.type !== "presence") throw new Error(`expected presence, got ${frame.type}`)
  return [...history.messages, ...flushed]
}

/** A turn already in the transcript before anyone attaches — what replay
 *  exists to recover. Written straight to the table because the bot's half
 *  of the conversation predates the socket entirely (§3.15.3 wrote it). */
async function seedMessage(
  conversationId: string,
  role: "visitor" | "assistant" | "agent",
  content: string,
): Promise<string> {
  const id = newId("msg")
  await db.insertInto("messages").values({
    id,
    conversation_id: conversationId,
    org_id: orgId,
    role,
    content,
    ...(role === "assistant" ? { model: "mock-llm" } : {}),
  }).execute()
  return id
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
    // An empty conversation still gets its backlog frame: a client must not
    // have to distinguish "no history yet" from "history did not arrive".
    expect(await visitor.next()).toEqual({ type: "history", messages: [] })
    expect(await visitor.next()).toEqual({ type: "presence", agents: 0, visitors: 1 })

    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    // The agent's own ready says active — attaching IS claiming, so there
    // is no separate button to forget to press.
    expect(await agent.next()).toEqual({ type: "ready", role: "agent", conversationId, status: "active" })
    expect(await agent.next()).toEqual({ type: "history", messages: [] })
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
    await open(visitor)
    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    await open(agent)
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
    await open(visitor)

    visitor.socket.send("not json at all")
    expect(await visitor.next()).toMatchObject({ type: "error", reason: expect.stringContaining("JSON") })

    visitor.send({ type: "whisper", text: "hello" })
    expect(await visitor.next()).toMatchObject({ type: "error", reason: "unsupported frame" })

    // A typing frame without its flag is refused rather than assumed: the
    // two things it could have meant are opposites.
    visitor.send({ type: "typing" })
    expect(await visitor.next()).toMatchObject({ type: "error", reason: expect.stringContaining("active") })

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
    await open(inAlpha)
    await open(inBeta)

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

  //#region Replay on reconnect (M4.3)
  it("replays the conversation — the bot's half included — to whoever attaches", async () => {
    const conversationId = await escalatedConversation("vis_history")
    const asked = await seedMessage(conversationId, "visitor", "how do I cancel my plan?")
    const answered = await seedMessage(conversationId, "assistant", "Cancel from Settings → Billing.")
    const helped = await seedMessage(conversationId, "agent", "I can do that for you now.")

    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_history"))
    const backlog = await open(visitor)
    // Chronological, and reaching back BEFORE the escalation: what the bot
    // said is part of the conversation, not a separate document.
    expect(backlog.map((m) => [m.id, m.role, m.text])).toEqual([
      [asked, "visitor", "how do I cancel my plan?"],
      [answered, "assistant", "Cancel from Settings → Billing."],
      [helped, "agent", "I can do that for you now."],
    ])
    expect(Number.isNaN(Date.parse(backlog[0]!.at))).toBe(false)

    // The agent gets the same backlog: reading what the bot already told
    // this visitor IS the job, and the socket must not make an arriving
    // agent go looking for it.
    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    expect((await open(agent)).map((m) => m.id)).toEqual([asked, answered, helped])

    await visitor.close()
    await agent.close()
  })

  it("gives a reconnecting client back what it said before the drop, on one clock", async () => {
    const conversationId = await escalatedConversation("vis_reconnect")
    const first = await connect(ticketFor(conversationId, "visitor", "vis_reconnect"))
    await open(first)
    first.send({ type: "message", text: "my card was charged twice" })
    const live = await first.next()
    if (live.type !== "message") throw new Error("expected the message back")
    await first.close()

    // A FRESH ticket: tickets are single use, so reconnecting is minting
    // again (§3.24) rather than re-spending something the client kept.
    const again = await connect(ticketFor(conversationId, "visitor", "vis_reconnect"))
    // Identical `at`, not merely a close one — the live frame and the
    // backlog both carry Postgres's clock, so a client merging the two
    // cannot have Render/Neon skew reorder its thread.
    expect(await open(again)).toEqual([
      { id: live.id, role: "visitor", text: "my card was charged twice", at: live.at },
    ])
    await again.close()
  })

  it("bounds the backlog at the newest turns rather than shipping a whole thread", async () => {
    const conversationId = await escalatedConversation("vis_long")
    const overflow = 5
    const base = Date.now() - 60 * 60 * 1000
    await db.insertInto("messages").values(
      Array.from({ length: HANDOFF_HISTORY_LIMIT + overflow }, (_, i) => ({
        id: newId("msg"),
        conversation_id: conversationId,
        org_id: orgId,
        role: "visitor" as const,
        content: `turn ${i}`,
        // Explicit timestamps: one bulk insert shares a transaction clock,
        // and rows tying on created_at would order by a random id.
        created_at: new Date(base + i * 1000),
      })),
    ).execute()

    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_long"))
    const backlog = await open(visitor)
    expect(backlog).toHaveLength(HANDOFF_HISTORY_LIMIT)
    // The NEWEST window, still in reading order — the oldest turns are what
    // a bounded backlog drops.
    expect(backlog[0]!.text).toBe(`turn ${overflow}`)
    expect(backlog.at(-1)!.text).toBe(`turn ${HANDOFF_HISTORY_LIMIT + overflow - 1}`)
    await visitor.close()
  })

  it("delivers each message exactly once to a client attaching mid-conversation", async () => {
    const conversationId = await escalatedConversation("vis_race")
    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    await open(agent)

    // Talk continuously ACROSS the visitor's attach so its backlog read and
    // the room's live broadcasts overlap. The interleaving is not forced —
    // and does not need to be: the assertion holds under every one of them,
    // which is the property. A message committed inside the window is
    // legally in both the read and the broadcast; the client must still see
    // it once, and none may go missing between the two.
    const turns = 12
    const chatter = (async () => {
      for (let i = 0; i < turns; i++) {
        agent.send({ type: "message", text: `turn ${i}` })
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    })()

    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_race"))
    const seen = new Map<string, string>()
    for (const message of await open(visitor)) seen.set(message.id, message.text)
    await chatter

    while (seen.size < turns) {
      const frame = await within(visitor.next(), 5_000, `${turns - seen.size} more messages`)
      if (frame.type !== "message") continue
      // The duplicate this buffer exists to prevent.
      expect(seen.has(frame.id)).toBe(false)
      seen.set(frame.id, frame.text)
    }
    expect([...seen.values()].sort()).toEqual(
      Array.from({ length: turns }, (_, i) => `turn ${i}`).sort(),
    )

    await visitor.close()
    await agent.close()
  })
  //#endregion

  //#region Typing (M4.3)
  it("relays typing to the other side, coalesces repeats, and never echoes it back", async () => {
    const conversationId = await escalatedConversation("vis_typing")
    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_typing"))
    await open(visitor)
    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    await open(agent)
    await visitor.next() // presence (agent joined)

    // Five keystrokes' worth in a burst. A per-keystroke client is not an
    // error, it is just a client — so the room pays for one frame, not five.
    for (let i = 0; i < 5; i++) visitor.send({ type: "typing", active: true })
    expect(await agent.next()).toEqual({ type: "typing", role: "visitor", active: true })

    visitor.send({ type: "message", text: "still there?" })
    // If the other four had been relayed, THIS would be a typing frame.
    expect(await agent.next()).toMatchObject({ type: "message", role: "visitor", text: "still there?" })
    // Sending ends composing: the indicator cannot outlive the sentence it
    // was announcing.
    expect(await agent.next()).toEqual({ type: "typing", role: "visitor", active: false })

    // The sender saw its own message (one order from one source of truth)
    // and none of its own typing frames (it knows).
    expect(await visitor.next()).toMatchObject({ type: "message", text: "still there?" })

    // And nothing about composing reached the transcript — typing is not
    // something anyone said.
    const rows = await db.selectFrom("messages").selectAll()
      .where("conversation_id", "=", conversationId).execute()
    expect(rows.map((r) => r.content)).toEqual(["still there?"])

    await visitor.close()
    await agent.close()
  })

  it("clears a typing indicator when the composer disconnects", async () => {
    const conversationId = await escalatedConversation("vis_ghost")
    const visitor = await connect(ticketFor(conversationId, "visitor", "vis_ghost"))
    await open(visitor)
    const agent = await connect(ticketFor(conversationId, "agent", agentId))
    await open(agent)
    await visitor.next() // presence (agent joined)

    visitor.send({ type: "typing", active: true })
    expect(await agent.next()).toEqual({ type: "typing", role: "visitor", active: true })

    await visitor.close()
    // The phantom-participant problem the heartbeat solves for presence,
    // solved here at the moment of close: a visitor who drops mid-sentence
    // must not leave "typing…" burning on the agent's screen.
    expect(await agent.next()).toEqual({ type: "typing", role: "visitor", active: false })
    expect(await agent.next()).toEqual({ type: "presence", agents: 1, visitors: 0 })

    await agent.close()
  })
  //#endregion
})

describe.skipIf(DB_CONFIGURED)("handoff socket (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})
