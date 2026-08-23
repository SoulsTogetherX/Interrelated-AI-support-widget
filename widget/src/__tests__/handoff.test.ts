//#region Imports
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { HandoffSocket } from "../handoff"
import type { HandoffStatus } from "../handoff"
import type { WidgetClient } from "../api"
import { TYPING_HINT_INTERVAL_MS, TYPING_TTL_MS } from "@shared/handoff/protocol"
import type { HandoffServerFrame } from "@shared/handoff/protocol"
//#endregion

//#region Fakes
/**
 * A scripted WebSocket: records what was sent, lets the test push server
 * frames, and closes on command. Cast to WebSocket at the seam — the widget
 * uses four members of it, and implementing EventTarget to satisfy a type
 * would be ceremony with no assertion in it.
 */
class FakeSocket {
  static live: FakeSocket[] = []
  readonly url: string
  readonly sent: string[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeSocket.live.push(this)
  }

  send(data: string): void {
    if (this.closed) throw new Error("send on a closed socket")
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** A server frame arriving. */
  deliver(frame: HandoffServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** The connection dropping from the other side. */
  drop(): void {
    this.closed = true
    this.onclose?.()
  }

  /** Every frame this socket sent, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }
}

const READY: HandoffServerFrame = {
  type: "ready", role: "visitor", conversationId: "con_1", status: "pending",
}

/** Only the two methods the socket calls; the rest of WidgetClient is not
 *  reachable from here, which is itself the seam being asserted. */
function fakeClient(tickets: Array<string | null | Error>): WidgetClient {
  return {
    ensureSession: () => Promise.resolve(),
    // eslint-disable-next-line require-yield
    async *ask() { throw new Error("not used") },
    escalate: () => Promise.reject(new Error("not used")),
    handoffTicket: () => {
      const next = tickets.shift()
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(next ?? null)
    },
    openHandoff: () => { throw new Error("not used") },
    rememberHandoff: () => { throw new Error("not used") },
    forgetHandoff: () => { throw new Error("not used") },
    storedHandoff: () => { throw new Error("not used") },
  } as WidgetClient
}

interface Harness {
  socket: HandoffSocket
  statuses: HandoffStatus[]
  messages: Array<{ id: string; text: string }>
  typing: boolean[]
  histories: number[]
}

function harness(tickets: Array<string | null | Error> = ["tkt_1"]): Harness {
  const statuses: HandoffStatus[] = []
  const messages: Array<{ id: string; text: string }> = []
  const typing: boolean[] = []
  const histories: number[] = []
  const socket = new HandoffSocket({
    apiBase: "https://api.test",
    conversationId: "con_1",
    client: fakeClient(tickets),
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    handlers: {
      onStatus: (status) => statuses.push(status),
      onHistory: (list) => histories.push(list.length),
      onMessage: (message) => messages.push({ id: message.id, text: message.text }),
      onTyping: (active) => typing.push(active),
    },
  })
  return { socket, statuses, messages, typing, histories }
}

/** The mint is a promise, so the socket appears a microtask later. */
async function connected(): Promise<FakeSocket> {
  await vi.waitFor(() => {
    if (FakeSocket.live.length === 0) throw new Error("no socket yet")
  })
  return FakeSocket.live.at(-1) as FakeSocket
}

beforeEach(() => {
  FakeSocket.live = []
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})
//#endregion

describe("HandoffSocket", () => {
  it("spends a fresh ticket in the URL and reports status from the server's frames", async () => {
    const h = harness(["tkt_1"])
    h.socket.open()
    const socket = await connected()

    // wss, the mounted path, and the ticket as the only query — the URL is
    // the only place a browser can put a credential on a handshake, which
    // is exactly why this one is disposable (§3.24).
    expect(socket.url).toBe("wss://api.test/v1/handoff?ticket=tkt_1")
    expect(h.statuses).toEqual(["connecting"])

    socket.deliver(READY)
    expect(h.statuses.at(-1)).toBe("waiting")
    socket.deliver({ type: "presence", agents: 1, visitors: 1 })
    expect(h.statuses.at(-1)).toBe("connected")
    socket.deliver({ type: "presence", agents: 0, visitors: 1 })
    expect(h.statuses.at(-1)).toBe("waiting")

    h.socket.close()
  })

  it("hands history and live messages to different callbacks", async () => {
    const h = harness()
    h.socket.open()
    const socket = await connected()
    socket.deliver(READY)
    socket.deliver({
      type: "history",
      messages: [
        { id: "msg_1", role: "visitor", text: "hi", at: "2026-01-01T00:00:00.000Z" },
        { id: "msg_2", role: "assistant", text: "I don't know that one.", at: "2026-01-01T00:00:01.000Z" },
      ],
    })
    socket.deliver({ type: "message", id: "msg_3", role: "agent", text: "I can help", at: "2026-01-01T00:00:02.000Z" })

    // The backlog arrives ONCE, as one thing to render over the thread; the
    // live message is a separate event. Collapsing them would double-render
    // a reconnecting client's whole conversation.
    expect(h.histories).toEqual([2])
    expect(h.messages).toEqual([{ id: "msg_3", text: "I can help" }])

    h.socket.close()
  })

  it("throttles composing hints to the protocol's interval and re-announces after sending", async () => {
    const h = harness()
    h.socket.open()
    const socket = await connected()
    socket.deliver(READY)

    // Five keystrokes inside one interval cost one frame.
    for (let i = 0; i < 5; i++) h.socket.hintTyping()
    expect(socket.frames()).toEqual([{ type: "typing", active: true }])

    // Sending ends composing server-side, so the throttle resets: the next
    // sentence must announce itself immediately rather than waiting out an
    // interval that started before the send.
    expect(h.socket.send("here is my order number")).toBe(true)
    h.socket.hintTyping()
    expect(socket.frames()).toEqual([
      { type: "typing", active: true },
      { type: "message", text: "here is my order number" },
      { type: "typing", active: true },
    ])

    h.socket.close()
  })

  it("expires an incoming typing indicator on its own, without a frame saying so", async () => {
    const h = harness()
    h.socket.open()
    const socket = await connected()
    socket.deliver(READY)

    socket.deliver({ type: "typing", role: "agent", active: true })
    expect(h.typing).toEqual([true])

    // Just under the TTL it stands; at the TTL the RECEIVER drops it. This
    // is why the server keeps no timer: an agent whose laptop closes
    // mid-sentence cannot leave "typing…" on a visitor's screen.
    vi.advanceTimersByTime(TYPING_TTL_MS - 1)
    expect(h.typing).toEqual([true])
    vi.advanceTimersByTime(1)
    expect(h.typing).toEqual([true, false])

    // A refresh inside the window keeps it up rather than re-announcing.
    socket.deliver({ type: "typing", role: "agent", active: true })
    vi.advanceTimersByTime(TYPING_HINT_INTERVAL_MS)
    socket.deliver({ type: "typing", role: "agent", active: true })
    vi.advanceTimersByTime(TYPING_TTL_MS - 1)
    expect(h.typing).toEqual([true, false, true, true])

    h.socket.close()
  })

  it("refuses to send before it is attached, so nothing is silently swallowed", async () => {
    const h = harness()
    h.socket.open()
    const socket = await connected()

    // Attached at the TCP level but not yet authenticated: a client that
    // treated this as sendable would drop the visitor's first sentence.
    expect(h.socket.send("hello?")).toBe(false)
    expect(socket.sent).toEqual([])

    socket.deliver(READY)
    expect(h.socket.send("hello?")).toBe(true)
    h.socket.close()
  })

  it("reconnects with a NEW ticket after a drop, and stops when the handoff is closed", async () => {
    const h = harness(["tkt_1", "tkt_2", null])
    h.socket.open()
    const first = await connected()
    first.deliver(READY)
    expect(h.statuses).toEqual(["connecting", "waiting"])

    first.drop()
    // A ticket is single use, so a reconnect is a fresh MINT — there is no
    // credential kept anywhere to replay.
    await vi.waitFor(() => {
      if (FakeSocket.live.length < 2) throw new Error("no reconnect yet")
    })
    const second = FakeSocket.live[1] as FakeSocket
    expect(second.url).toBe("wss://api.test/v1/handoff?ticket=tkt_2")
    second.deliver(READY)

    // Third attempt: the mint answers "no open handoff" — terminal, because
    // an agent closing the conversation is a decision, not an outage.
    second.drop()
    await vi.waitFor(() => {
      if (h.statuses.at(-1) !== "ended") throw new Error(`still ${h.statuses.at(-1)}`)
    })
    expect(FakeSocket.live).toHaveLength(2)

    // And it stays stopped: no further sockets, ever.
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.live).toHaveLength(2)
  })

  it("ends on a `closed` frame without spending a reconnect to find out", async () => {
    // Two tickets are available: the assertion is that the SECOND is never
    // minted, because the server said what happened instead of just
    // hanging up (M4.6).
    const h = harness(["tkt_1", "tkt_2"])
    h.socket.open()
    const socket = await connected()
    socket.deliver(READY)
    expect(h.statuses.at(-1)).toBe("waiting")

    socket.deliver({ type: "closed" })
    expect(h.statuses.at(-1)).toBe("ended")
    expect(socket.closed).toBe(true)

    // The disconnect that follows a real close must not restart anything.
    socket.drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.live).toHaveLength(1)
  })

  it("keeps retrying when the ticket mint FAILS — an outage is not a decision", async () => {
    const h = harness([new Error("network down"), "tkt_2"])
    h.socket.open()
    await vi.waitFor(() => {
      if (FakeSocket.live.length === 0) throw new Error("no retry yet")
    })
    expect((FakeSocket.live[0] as FakeSocket).url).toContain("ticket=tkt_2")
    expect(h.statuses).not.toContain("ended")
    h.socket.close()
  })

  it("stops reconnecting once closed by the widget", async () => {
    const h = harness(["tkt_1", "tkt_2"])
    h.socket.open()
    const socket = await connected()
    socket.deliver(READY)

    h.socket.close()
    socket.drop() // the close event a real socket fires on the way out
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.live).toHaveLength(1)
  })

  it("reports nothing after close(), even when the mint in flight comes back null", async () => {
    // A rejoin the widget gave up on (M7.4) closes the socket while its
    // ticket mint may still be pending. If that mint then answers "no open
    // handoff", the answer is nobody's business: a status reported after
    // close() would land on a UI that has already moved on — here, it would
    // make an abandoned rejoin forget a bookmark it meant to keep.
    let answer!: (ticket: string | null) => void
    const pending = new Promise<string | null>((resolve) => { answer = resolve })
    const statuses: HandoffStatus[] = []
    const socket = new HandoffSocket({
      apiBase: "https://api.test",
      conversationId: "con_1",
      client: { ...fakeClient([]), handoffTicket: () => pending },
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
      handlers: {
        onStatus: (status) => statuses.push(status),
        onHistory: () => {},
        onMessage: () => {},
        onTyping: () => {},
      },
    })
    socket.open()
    expect(statuses).toEqual(["connecting"])
    socket.close()
    answer(null)
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(statuses).toEqual(["connecting"])
    expect(FakeSocket.live).toHaveLength(0)
  })
})
