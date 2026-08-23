//#region Type Defs
/**
 * The handoff-socket load scenario (M4.7) — the harness the plan asks for,
 * producing the concurrency and latency numbers the README quotes.
 *
 * What it measures, and why those three:
 *
 * - **connect**: ticket → upgrade → `ready` → `history`. This is the cost of
 *   a visitor arriving, and it is the one that includes a database read
 *   (the backlog, §3.25), so it is where replay would show up if replay
 *   were expensive.
 * - **round trip**: a client's own message coming back to it. The server
 *   persists BEFORE it broadcasts (§3.25), so this number contains a real
 *   Postgres write — it is the honest "did my message land" latency, not a
 *   relay benchmark.
 * - **delivery**: one end's message reaching the OTHER end. This is the
 *   product's actual promise, and it is measured across two sockets in one
 *   process so both timestamps come from one clock — the same reason the
 *   server broadcasts Postgres's `created_at` rather than its own (§3.25).
 *
 * Zero dependencies: Node's global WebSocket (stable since 22) is the
 * client, so this harness runs with `node`/`tsx` and nothing installed —
 * the same standard the .mjs probes in scripts/ hold themselves to.
 *
 * Deliberately NOT part of CI. Latency on a shared GitHub runner measures
 * the runner, and a flaky p95 gate would train everyone to ignore it. The
 * eval harness is a CI gate because recall is deterministic; this is a
 * measurement tool that a human runs and publishes.
 */
interface HandoffLoadConfig {
  /** ws:// or wss:// base, e.g. ws://localhost:3000 */
  wsBase: string
  /** One session = one conversation = a visitor socket AND an agent socket
   *  (the product's unit: somebody waiting, somebody answering). */
  sessions: SessionTickets[]
  /** Messages each SIDE sends per session. */
  messagesPerSide: number
  /** Pacing between one client's messages. Human typing is seconds apart;
   *  the default is far faster on purpose — the point is to find the
   *  service's ceiling, not to simulate politeness. */
  intervalMs: number
  /** How long to wait for stragglers after the last send before declaring
   *  the run over. A message still in flight is not a lost one. */
  drainMs: number
  /** Progress line, so a long run is not a silent one. */
  log?: (line: string) => void
}

interface SessionTickets {
  conversationId: string
  visitorTicket: string
  agentTicket: string
}

interface HandoffLoadResult {
  connect: Histogram
  roundTrip: Histogram
  delivery: Histogram
  /** Sockets that reached `ready` — the "N concurrent sessions" number. */
  connected: number
  /** Messages that were sent and whose echo came back. */
  echoed: number
  /** Messages that reached the other side. */
  delivered: number
  /** Messages sent but never echoed by the drain deadline. */
  lost: number
  sendErrors: number
  socketErrors: number
  /** Wall time from first send to last receive, for the throughput line. */
  elapsedMs: number
}
//#endregion

//#region Imports
import { Histogram } from "./histogram"
import type { HandoffServerFrame } from "../shared/handoff/protocol"
//#endregion

//#region Helpers
/** Every message carries its own id in the TEXT, because the protocol gives
 *  the server the last word on message ids (§2.4.7) — the sender cannot
 *  correlate an echo by an id it never chose. A tagged body is the smallest
 *  thing that survives the round trip unchanged. */
const TAG = /^#(\d+)\|/

function tagged(index: number): string {
  return `#${index}|load test message, sent to measure the round trip`
}

function tagOf(text: string): number | null {
  const match = TAG.exec(text)
  return match ? Number(match[1]) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
//#endregion

//#region Runner
/**
 * One participant's socket. Connect resolves when the server has said
 * `ready` AND `history` — i.e. when the client is genuinely usable, not
 * merely when TCP came up. Anything less would report a connect latency
 * that excludes the backlog read, which is the interesting part.
 */
class Participant {
  readonly socket: WebSocket
  readonly #onMessage: (tag: number, at: number) => void
  #ready = false

  constructor(url: string, onMessage: (tag: number, at: number) => void) {
    this.#onMessage = onMessage
    this.socket = new WebSocket(url)
    this.socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return
      let frame: HandoffServerFrame
      try {
        frame = JSON.parse(event.data) as HandoffServerFrame
      } catch {
        return
      }
      if (frame.type !== "message") return
      const tag = tagOf(frame.text)
      if (tag !== null) this.#onMessage(tag, performance.now())
    })
  }

  /** Resolves with the connect latency, or rejects if the upgrade failed. */
  waitReady(timeoutMs: number): Promise<number> {
    const started = performance.now()
    return new Promise<number>((resolve, reject) => {
      let sawReady = false
      const timer = setTimeout(() => reject(new Error("timed out waiting for ready/history")), timeoutMs)
      const onMessage = (event: MessageEvent): void => {
        if (typeof event.data !== "string") return
        const frame = JSON.parse(event.data) as HandoffServerFrame
        if (frame.type === "ready") sawReady = true
        // history follows ready (§3.25's opening order), and it is the frame
        // that means the backlog read is done.
        if (sawReady && frame.type === "history") {
          clearTimeout(timer)
          this.socket.removeEventListener("message", onMessage)
          this.#ready = true
          resolve(performance.now() - started)
        }
      }
      this.socket.addEventListener("message", onMessage)
      this.socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("socket error before ready"))
      })
      this.socket.addEventListener("close", () => {
        clearTimeout(timer)
        if (!this.#ready) reject(new Error("closed before ready"))
      })
    })
  }

  send(text: string): void {
    this.socket.send(JSON.stringify({ type: "message", text }))
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      // Already gone; nothing to do and nothing to report.
    }
  }
}

async function runHandoffLoad(config: HandoffLoadConfig): Promise<HandoffLoadResult> {
  const log = config.log ?? (() => {})
  const connect = new Histogram()
  const roundTrip = new Histogram()
  const delivery = new Histogram()

  /** tag → when it was sent. One map for the whole run: tags are unique
   *  across sessions, so a message arriving in the wrong room would show up
   *  as a delivery to a participant that never expected it. */
  const sentAt = new Map<number, number>()
  const echoedTags = new Set<number>()
  const deliveredTags = new Set<number>()
  let socketErrors = 0
  let sendErrors = 0

  // Each participant knows which tags are ITS OWN, so the same incoming
  // frame is an echo for one side and a delivery for the other — which is
  // exactly the distinction the two histograms draw.
  const owned = new Map<number, Set<number>>() // participant index → tags

  const participants: Participant[] = []
  // The instant the last message was accounted for. Throughput divides by
  // THIS minus the first send — not by the wall clock, which would include
  // the drain window and understate the rate by however long that window
  // happened to be (a 6 s drain on a 9 s run reported 106/s for what was
  // really 178/s).
  let lastReceiveAt = 0
  const record = (self: number) => (tag: number, at: number): void => {
    const sent = sentAt.get(tag)
    if (sent === undefined) return
    lastReceiveAt = Math.max(lastReceiveAt, at)
    const mine = owned.get(self)?.has(tag) ?? false
    if (mine) {
      if (echoedTags.has(tag)) return
      echoedTags.add(tag)
      roundTrip.record(at - sent)
    } else {
      if (deliveredTags.has(tag)) return
      deliveredTags.add(tag)
      delivery.record(at - sent)
    }
  }

  // ── Connect ──────────────────────────────────────────────────────────────
  // Sequentially per session, both sides together: an agent attaching is
  // what CLAIMS the handoff (§3.25), so two sessions connecting at once is
  // realistic while a thundering herd of 200 upgrades is a different test
  // (and would measure the accept queue, not the product).
  for (const [index, session] of config.sessions.entries()) {
    const visitorIndex = participants.length
    const agentIndex = visitorIndex + 1
    owned.set(visitorIndex, new Set())
    owned.set(agentIndex, new Set())

    const visitor = new Participant(
      `${config.wsBase}/v1/handoff?ticket=${encodeURIComponent(session.visitorTicket)}`,
      record(visitorIndex),
    )
    const agent = new Participant(
      `${config.wsBase}/v1/handoff?ticket=${encodeURIComponent(session.agentTicket)}`,
      record(agentIndex),
    )
    participants.push(visitor, agent)

    try {
      const [visitorMs, agentMs] = await Promise.all([
        visitor.waitReady(15_000),
        agent.waitReady(15_000),
      ])
      connect.record(visitorMs)
      connect.record(agentMs)
    } catch (error) {
      socketErrors += 1
      log(`  session ${index}: ${(error as Error).message}`)
    }
    if ((index + 1) % 25 === 0) log(`  connected ${index + 1}/${config.sessions.length} sessions`)
  }
  const connected = connect.count
  log(`connected ${connected} sockets (${config.sessions.length} sessions × 2)`)

  // ── Traffic ──────────────────────────────────────────────────────────────
  const startedAt = performance.now()
  let nextTag = 0
  const senders = participants.map((participant, index) => async (): Promise<void> => {
    // Stagger each participant across one interval before it starts.
    //
    // Without this every client fires at the same instant, and the run
    // measures how fast the service drains a synchronized herd rather than
    // what a message costs: at 200 clients on a 4 s interval the offered
    // rate averaged 38/s but arrived as bursts of 200, and the p50 that
    // came out (365 ms) was almost entirely queue wait. Two hundred people
    // do not type in unison; spreading arrivals is the more honest model
    // AND the one whose number means something. Bursts are worth measuring
    // too — that is what a low --interval with a high --sessions now does
    // deliberately rather than by accident.
    await sleep(Math.random() * config.intervalMs)
    for (let n = 0; n < config.messagesPerSide; n++) {
      const tag = nextTag++
      owned.get(index)?.add(tag)
      sentAt.set(tag, performance.now())
      try {
        participant.send(tagged(tag))
      } catch {
        sendErrors += 1
        sentAt.delete(tag)
      }
      await sleep(config.intervalMs)
    }
  })
  await Promise.all(senders.map((send) => send()))

  // A message still in flight is not a lost one; give the tail a window.
  await sleep(config.drainMs)
  // Zero receives means nothing worked; report the wall clock rather than a
  // negative interval, and let `lost` say what happened.
  const elapsedMs = lastReceiveAt > 0 ? lastReceiveAt - startedAt : performance.now() - startedAt

  for (const participant of participants) participant.close()

  return {
    connect,
    roundTrip,
    delivery,
    connected,
    echoed: echoedTags.size,
    delivered: deliveredTags.size,
    lost: sentAt.size - echoedTags.size,
    sendErrors,
    socketErrors,
    elapsedMs,
  }
}
//#endregion

//#region Exports
export { runHandoffLoad, tagged, tagOf }
export type { HandoffLoadConfig, HandoffLoadResult, SessionTickets }
//#endregion
