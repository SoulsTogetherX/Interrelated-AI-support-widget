#!/usr/bin/env node
// Security probe (M6) — attacks the LIVE stack from the outside, the way a
// script on the internet would, and exits nonzero on the first layer that
// gives. Where smoke-test.mjs asks "is the surface mounted and closed?",
// this asks "does each layer of the trust model actually hold against the
// requests it exists to stop?" — the origin allowlist, key state, session
// tokens, tenant isolation, input bounds, the handoff socket, server-side
// session minting with the secret key (M7.3), and the rate limits — with a
// seeded tenant to attack rather than posture alone.
//
// Zero dependencies, like every probe here: Node 22's stdlib is enough
// (fetch, the global WebSocket client, node:http for raw upgrade handshakes),
// so CI runs it without an npm install and it can be pointed at any
// deployment from any machine.
//
// Usage:
//   node scripts/security-probe.mjs [baseUrl] [--fixture path.json]
//
// The fixture is what `npm run seed-security` (realtime/scripts/
// seedSecurityFixture.ts) writes: two probe orgs with keys, origins, and
// known content. WITHOUT it the probe runs its posture subset — what can be
// verified against a stack with no tenant to attack — and says so; WITH it
// the full suite runs. Against production, run posture-only unless you have
// seeded the probe orgs there on purpose.
//
// The internal-API checks (SSRF payloads, credential read-back) additionally
// need INTERNAL_API_SECRET in the environment, and run only when it is
// present: that secret is the admin key, and a probe pointed at production
// must never carry it. CI's e2e stack sets a throwaway one.
//
// Two conventions worth knowing before reading the checks:
//   · Every mint and chat consumes a token bucket in the SERVICE, by design.
//     Where a check is not itself about rate limiting, a 429 is answered by
//     waiting for the bucket to refill and retrying, so a re-run within a
//     minute of the last is slow rather than wrong. The rate-limit checks
//     themselves come LAST, and never retry.
//   · Negative checks have positive controls. "Org B cannot retrieve org
//     A's content" is only evidence if org A can retrieve its own — so that
//     is asserted first, and a failed control fails the run rather than
//     letting everything after it pass vacuously.

import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

//#region Arguments
const args = process.argv.slice(2)
const positional = args.filter((arg) => !arg.startsWith("--"))
const base = (positional[0] ?? "http://localhost:3000").replace(/\/$/, "")
const fixturePath = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : undefined
const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : null
const internalSecret = process.env.INTERNAL_API_SECRET || null
const wsBase = base.replace(/^http/, "ws")
//#endregion

//#region Harness
let failures = 0
let passes = 0
let skips = 0

async function check(name, fn) {
  try {
    await fn()
    passes++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}: ${err.message}`)
  }
}

function skip(name, why) {
  skips++
  console.log(`skip  ${name} — ${why}`)
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** fetch with a timeout: a probe that can hang turns a dead service into a
 *  stuck CI job. */
function request(path, init = {}, ms = 15_000) {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(ms) })
}

/** POST JSON. `patient` retries a 429 after the mint/chat buckets have had
 *  time to refill (6 s per mint token, 10 s per visitor chat token) — for
 *  checks that are not about rate limits. Bounded, so a service that 429s
 *  forever still fails loudly. */
async function postJson(path, body, headers = {}, { patient = true, timeoutMs = 15_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }, timeoutMs)
    if (res.status === 429 && patient && attempt < 12) {
      await res.arrayBuffer()
      console.log(`      (429 from ${path} — waiting for the bucket to refill)`)
      await sleep(7_000)
      continue
    }
    return res
  }
}

/** Parses an SSE body into its JSON events. The chat route writes
 *  `data: <json>\n\n` per event and ends the response after `done`, so the
 *  whole stream is one text() away. */
function sseEvents(text) {
  return text.split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)))
}

/** Sends a raw WebSocket handshake and resolves with the HTTP status the
 *  server answered — 101 if it upgraded (the socket is then destroyed). fetch
 *  cannot do this, and the global WebSocket hides the status; the status IS
 *  the assertion here (refused BEFORE a socket exists, never accepted-then-
 *  closed). */
async function upgradeStatus(path) {
  const { request: httpRequest } = await import(base.startsWith("https") ? "node:https" : "node:http")
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==",
      },
      timeout: 15_000,
    })
    req.on("response", (res) => { res.resume(); resolve(res.statusCode) })
    req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101) })
    req.on("timeout", () => { req.destroy(); reject(new Error("upgrade timed out")) })
    req.on("error", reject)
    req.end()
  })
}

/** Opens a handoff socket with Node's global WebSocket and collects its
 *  frames, with a `next(predicate)` that waits for one. */
function openSocket(ticket) {
  const ws = new WebSocket(`${wsBase}/v1/handoff?ticket=${encodeURIComponent(ticket)}`)
  const frames = []
  const waiters = []
  let closed = false
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    frames.push(frame)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(frame)
      }
    }
  })
  ws.addEventListener("close", () => { closed = true })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error("socket errored before opening")))
  })
  return {
    ws,
    frames,
    opened,
    isClosed: () => closed,
    send: (frame) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
    next: (predicate, ms = 10_000) => {
      const already = frames.find(predicate)
      if (already) return Promise.resolve(already)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no matching frame within timeout")), ms)
        waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame) } })
      })
    },
    close: () => ws.close(),
  }
}
//#endregion

console.log(`security-probe against ${base}`)
console.log(fixture ? `  fixture: ${fixturePath} (seeded ${fixture.seededAt}, orgs ${fixture.orgs.a.id} / ${fixture.orgs.b.id})` : "  no fixture — posture checks only")
console.log(internalSecret ? "  internal API secret present — SSRF and read-back checks enabled" : "  no INTERNAL_API_SECRET — internal API checks skipped")

//#region A. Posture — what holds with no tenant at all
console.log("\n[A] posture")

await check("a request body over the 64 KB cap is refused with 413 before any route runs", async () => {
  // Bodies are capped in app.ts, ahead of auth: a big JSON limit is a free
  // memory-pressure lever, and it must not cost a session token to find out.
  const res = await request("/v1/widget/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://anyone.example" },
    body: JSON.stringify({ question: "x".repeat(70_000) }),
  })
  expect(res.status === 413, `status ${res.status}`)
})

await check("a WebSocket upgrade with no ticket is refused with 401, and a forged ticket identically", async () => {
  expect((await upgradeStatus("/v1/handoff")) === 401, "no ticket was not 401")
  expect((await upgradeStatus("/v1/handoff?ticket=forged.forged.forged")) === 401, "forged ticket was not 401")
})

await check("30 concurrent unticketed upgrade attempts are all refused and the service stays healthy", async () => {
  const statuses = await Promise.all(Array.from({ length: 30 }, () => upgradeStatus("/v1/handoff")))
  expect(statuses.every((s) => s === 401), `statuses ${[...new Set(statuses)].join(",")}`)
  const health = await request("/api/health")
  expect(health.status === 200, `health ${health.status} after the flood`)
})

await check("the internal API is closed to outsiders (404 unconfigured, 401 configured)", async () => {
  const res = await request("/internal/orgs/org_probe/credentials")
  expect(res.status === 404 || res.status === 401, `status ${res.status}`)
})
//#endregion

if (!fixture) {
  skip("[B]–[G] tenant checks", "no --fixture given (npm run seed-security writes one)")
} else {
  const { a: orgA, b: orgB } = fixture.orgs

  //#region B. Layer 1 — the origin allowlist and key state
  console.log("\n[B] origin allowlist + key state")

  await check("an unlisted origin is refused with 403 and NO CORS headers — a copied snippet dies here", async () => {
    const res = await postJson("/v1/widget/session", { publishableKey: orgA.publishableKey }, { origin: "https://thief.example" })
    expect(res.status === 403, `status ${res.status}`)
    expect(res.headers.get("access-control-allow-origin") === null, "CORS header present on a refused origin")
  })

  await check("Origin: null (file://, sandboxed iframes) is refused", async () => {
    const res = await postJson("/v1/widget/session", { publishableKey: orgA.publishableKey }, { origin: "null" })
    expect(res.status === 403, `status ${res.status}`)
  })

  await check("a case-variant of the allowlisted origin is refused — the match is exact", async () => {
    const variant = orgA.origin.replace("https://", "https://").replace(/probe-a/, "Probe-A")
    const res = await postJson("/v1/widget/session", { publishableKey: orgA.publishableKey }, { origin: variant })
    expect(res.status === 403, `status ${res.status}`)
  })

  await check("a missing Origin header is refused without spending a mint token", async () => {
    const res = await postJson("/v1/widget/session", { publishableKey: orgA.publishableKey })
    expect(res.status === 403, `status ${res.status}`)
  })

  let unknownKeyBody = null
  await check("an unknown publishable key is refused with 401", async () => {
    const res = await postJson("/v1/widget/session", { publishableKey: "pk_live_00000000000000000000000000000000" }, { origin: orgA.origin })
    expect(res.status === 401, `status ${res.status}`)
    unknownKeyBody = await res.text()
  })

  await check("a REVOKED key is refused identically to an unknown one — key state is not probeable", async () => {
    // orgA.revokedKey was live and was rotated out; from outside it must be
    // indistinguishable from a key that never existed: same status, same
    // body, byte for byte.
    const res = await postJson("/v1/widget/session", { publishableKey: orgA.revokedKey }, { origin: orgA.origin })
    expect(res.status === 401, `status ${res.status}`)
    const body = await res.text()
    expect(body === unknownKeyBody, `body differs: revoked=${body} unknown=${unknownKeyBody}`)
  })

  await check("a malformed key is refused with the same 401", async () => {
    const res = await postJson("/v1/widget/session", { publishableKey: "sk_live_not_a_public_key" }, { origin: orgA.origin })
    expect(res.status === 401, `status ${res.status}`)
    expect((await res.text()) === unknownKeyBody, "body differs from the unknown-key answer")
  })
  //#endregion

  //#region Sessions for the rest of the run
  async function mint(org, visitorId) {
    const res = await postJson("/v1/widget/session", { publishableKey: org.publishableKey, visitorId }, { origin: org.origin })
    if (res.status !== 200) throw new Error(`mint for ${org.name} failed: ${res.status} ${await res.text()}`)
    const corsEcho = res.headers.get("access-control-allow-origin")
    if (corsEcho !== org.origin) throw new Error(`mint CORS echo was ${corsEcho}, expected ${org.origin}`)
    return await res.json()
  }

  const stamp = Date.now().toString(36)
  // Browser-minted visitor ids must be ANONYMOUS-shaped (vis_ + 32 hex —
  // what the widget stores and hands back); since M7.3 the route refuses
  // any other shape, because a non-anonymous id is a server-asserted
  // identity, and section [I] checks exactly that refusal.
  const anonymousVisitor = () => `vis_${randomBytes(16).toString("hex")}`
  const visitorA1 = anonymousVisitor()
  let sessionA1, sessionA2, sessionB1
  await check("the allowlisted origin mints sessions, with CORS echoing exactly that origin", async () => {
    sessionA1 = await mint(orgA, visitorA1)
    sessionA2 = await mint(orgA, anonymousVisitor())
    sessionB1 = await mint(orgB, anonymousVisitor())
    expect(typeof sessionA1.token === "string" && sessionA1.token.length > 20, "no token in mint response")
    expect(sessionA1.visitorId === visitorA1, "visitor id was not honored")
  })
  if (!sessionA1 || !sessionA2 || !sessionB1) {
    console.error("\ncannot continue without sessions")
    process.exit(1)
  }

  const bearer = (session) => ({ authorization: `Bearer ${session.token}` })

  /** One chat turn; returns { status, events, headers, raw }. */
  async function chat(session, origin, body, options = {}) {
    const res = await postJson("/v1/widget/chat", body, { origin, ...bearer(session) }, { ...options, timeoutMs: 30_000 })
    const raw = await res.text()
    return { status: res.status, headers: res.headers, raw, events: res.status === 200 ? sseEvents(raw) : [] }
  }
  //#endregion

  //#region C. Layer 2 — session tokens
  console.log("\n[C] session tokens")

  await check("a tampered token is refused with 401", async () => {
    // Flip a character in the MIDDLE of the token, never the last one: the
    // final base64url character of a 32-byte signature carries two real bits
    // and four of padding, so "A" → "B" there decodes to the same bytes and
    // is not a tamper at all — a check that flipped it passed by luck.
    const token = sessionA1.token
    const at = Math.floor(token.length / 2)
    const replacement = token[at] === "a" ? "b" : "a"
    const tampered = token.slice(0, at) + replacement + token.slice(at + 1)
    const res = await postJson("/v1/widget/chat", { question: "hello" }, { origin: orgA.origin, authorization: `Bearer ${tampered}` })
    expect(res.status === 401, `status ${res.status}`)
  })

  await check("a valid token replayed from ANOTHER origin is refused with 403 and no CORS", async () => {
    // The token binds the origin it was minted for. Exfiltrated to another
    // site, it is worthless — and that site's browser cannot even read the
    // refusal.
    const res = await postJson("/v1/widget/chat", { question: "hello" }, { origin: "https://thief.example", ...bearer(sessionA1) })
    expect(res.status === 403, `status ${res.status}`)
    expect(res.headers.get("access-control-allow-origin") === null, "CORS header present on the replay refusal")
  })

  await check("org A's token presented from org B's (allowlisted) origin is still refused", async () => {
    const res = await postJson("/v1/widget/chat", { question: "hello" }, { origin: orgB.origin, ...bearer(sessionA1) })
    expect(res.status === 403, `status ${res.status}`)
  })

  await check("a garbage bearer and a missing bearer get the same 401", async () => {
    const garbage = await postJson("/v1/widget/chat", { question: "hello" }, { origin: orgA.origin, authorization: "Bearer not.a.token" })
    const missing = await postJson("/v1/widget/chat", { question: "hello" }, { origin: orgA.origin })
    expect(garbage.status === 401 && missing.status === 401, `statuses ${garbage.status}/${missing.status}`)
    expect((await garbage.text()) === (await missing.text()), "bodies differ")
  })
  //#endregion

  //#region D. Tenant isolation — retrieval and conversation hijack
  console.log("\n[D] tenant isolation")

  const knownA = orgA.corpus[0]
  // Everything org A legitimately holds — its plain pages AND the poisoned
  // ones (eval/injection.jsonl, seeded into the same org): a citation to
  // either is a citation to A's own documentation.
  const orgAUrls = new Set([...orgA.corpus.map((c) => c.url), ...(orgA.poisoned ?? []).map((p) => p.url)])
  let conversationA1 = null
  await check("CONTROL: org A retrieves its own content and cites its own URL", async () => {
    // The positive control every negative below depends on. If this fails,
    // the cross-tenant refusals prove nothing.
    const { status, events, headers } = await chat(sessionA1, orgA.origin, { question: knownA.text })
    expect(status === 200, `status ${status}`)
    expect(headers.get("access-control-allow-origin") === orgA.origin, "SSE response lacks the CORS echo")
    const meta = events.find((e) => e.type === "meta")
    const claims = events.filter((e) => e.type === "claim")
    expect(meta && typeof meta.conversationId === "string", "no meta event")
    expect(claims.length > 0, `no claim events (got ${events.map((e) => e.type).join(",")})`)
    expect(claims.every((c) => orgAUrls.has(c.url)), `a claim cited a URL outside org A's corpus: ${claims.map((c) => c.url).join(",")}`)
    expect(claims.some((c) => c.url === knownA.url), "the retrieved sentence was not the one cited")
    conversationA1 = meta.conversationId
  })
  if (conversationA1 === null) {
    // Without a conversation of A1's, every check below that continues,
    // escalates, or tickets it would fail for the wrong reason. Say so once
    // instead of twelve times.
    console.error("\nthe retrieval CONTROL failed — the isolation and handoff checks that depend on it are skipped, not passed")
    skip("[D] continuation + [F] handoff socket", "no conversation to attack (control failed)")
  }

  await check("org B asking for org A's exact sentence retrieves NOTHING of A's — refusal, no claim, no leak", async () => {
    // Same question, other tenant. Under exact-match retrieval this is the
    // strongest form of the test: the sentence exists verbatim in the
    // database, one org filter away.
    const { status, events, raw } = await chat(sessionB1, orgB.origin, { question: knownA.text })
    expect(status === 200, `status ${status}`)
    expect(events.every((e) => e.type !== "claim"), "org B received a claim for org A's content")
    expect(events.some((e) => e.type === "refusal"), `expected a refusal (got ${events.map((e) => e.type).join(",")})`)
    for (const chunk of orgA.corpus) {
      expect(!raw.includes(chunk.url), `org A's URL ${chunk.url} appeared in org B's stream`)
    }
  })

  if (conversationA1 !== null) {
    await check("another visitor of the same org cannot continue this conversation — one opaque error, nothing learned", async () => {
      const { status, events } = await chat(sessionA2, orgA.origin, { question: knownA.text, conversationId: conversationA1 })
      expect(status === 200, `status ${status}`)
      expect(events.length === 1 && events[0].type === "error", `events ${events.map((e) => e.type).join(",")}`)
      expect(Object.keys(events[0]).join(",") === "type", `error event carries detail: ${JSON.stringify(events[0])}`)
    })

    await check("another ORG cannot continue it either, with the identical opaque error", async () => {
      const { events } = await chat(sessionB1, orgB.origin, { question: knownA.text, conversationId: conversationA1 })
      expect(events.length === 1 && events[0].type === "error", `events ${events.map((e) => e.type).join(",")}`)
    })
  }

  await check("a fabricated conversation id is refused with 400 before any work", async () => {
    const { status } = await chat(sessionA2, orgA.origin, { question: "hi", conversationId: "con_00000000000000000000000000000000".slice(0, 20) })
    expect(status === 400, `status ${status}`)
  })
  //#endregion

  //#region E. Input bounds
  console.log("\n[E] input bounds")

  await check("a question over 2,000 characters is refused with 400", async () => {
    const { status } = await chat(sessionB1, orgB.origin, { question: "x".repeat(2_001) })
    expect(status === 400, `status ${status}`)
  })

  await check("an empty question is refused with 400", async () => {
    const { status } = await chat(sessionB1, orgB.origin, { question: "   " })
    expect(status === 400, `status ${status}`)
  })

  await check("a non-JSON body is refused, not crashed on", async () => {
    const res = await request("/v1/widget/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: orgA.origin, ...bearer(sessionA2) },
      body: "{not json",
    })
    expect(res.status === 400, `status ${res.status}`)
  })
  //#endregion

  //#region F. The handoff socket
  console.log("\n[F] handoff socket")

  if (conversationA1 !== null) {
  await check("escalating a conversation this visitor does not own is a 404 that reveals nothing", async () => {
    const res = await postJson("/v1/widget/escalate", { conversationId: conversationA1 }, { origin: orgA.origin, ...bearer(sessionA2) })
    expect(res.status === 404, `status ${res.status}`)
    const foreign = await postJson("/v1/widget/escalate", { conversationId: conversationA1 }, { origin: orgB.origin, ...bearer(sessionB1) })
    expect(foreign.status === 404, `cross-org status ${foreign.status}`)
  })

  await check("the owner escalates once; a repeat reports the same handoff without creating another", async () => {
    const first = await postJson("/v1/widget/escalate", { conversationId: conversationA1 }, { origin: orgA.origin, ...bearer(sessionA1) })
    const firstText = await first.text()
    expect(first.status === 200, `status ${first.status} ${firstText}`)
    const body = JSON.parse(firstText)
    expect(body.status === "pending" && body.created === true, `first: ${JSON.stringify(body)}`)
    const again = await postJson("/v1/widget/escalate", { conversationId: conversationA1 }, { origin: orgA.origin, ...bearer(sessionA1) })
    const repeat = await again.json()
    expect(repeat.created === false, `repeat: ${JSON.stringify(repeat)}`)
  })

  await check("a handoff ticket is refused for a conversation the visitor does not own", async () => {
    const res = await postJson("/v1/widget/handoff-ticket", { conversationId: conversationA1 }, { origin: orgA.origin, ...bearer(sessionA2) })
    expect(res.status === 404, `status ${res.status}`)
  })

  let ticket = null
  await check("the owner gets a ticket, and it opens the socket: ready → history → presence", async () => {
    const res = await postJson("/v1/widget/handoff-ticket", { conversationId: conversationA1 }, { origin: orgA.origin, ...bearer(sessionA1) })
    expect(res.status === 200, `status ${res.status}`)
    ticket = (await res.json()).ticket
    expect(typeof ticket === "string", "no ticket")
  })

  let socket = null
  await check("the socket authenticates at upgrade and greets with ready → history → presence", async () => {
    socket = openSocket(ticket)
    await socket.opened
    await socket.next((f) => f.type === "presence")
    expect(socket.frames.slice(0, 3).map((f) => f.type).join(",") === "ready,history,presence", `opening frames ${socket.frames.map((f) => f.type).join(",")}`)
    expect(socket.frames[0].role === "visitor", `ready role ${socket.frames[0].role}`)
    expect(socket.frames[0].conversationId === conversationA1, "ready names the wrong conversation")
  })

  await check("a REPLAYED ticket is refused at upgrade — single use", async () => {
    expect((await upgradeStatus(`/v1/handoff?ticket=${encodeURIComponent(ticket)}`)) === 401, "replayed ticket was accepted")
  })

  await check("a frame claiming role 'agent' is stored and echoed as the VISITOR — role comes from the ticket", async () => {
    const text = `probe-role-${stamp}`
    socket.send({ type: "message", text, role: "agent" })
    const echo = await socket.next((f) => f.type === "message" && f.text === text)
    expect(echo.role === "visitor", `echoed role ${echo.role}`)
  })

  await check("garbage, unsupported, and oversized frames get an error frame and the socket STAYS OPEN", async () => {
    socket.send("this is not json")
    await socket.next((f) => f.type === "error")
    const before = socket.frames.filter((f) => f.type === "error").length
    socket.send({ type: "message", text: "x".repeat(4_001) })
    await socket.next((f) => f.type === "error" && socket.frames.filter((g) => g.type === "error").length > before)
    socket.send({ type: "teleport", to: "admin" })
    await socket.next((f) => f.type === "error" && socket.frames.filter((g) => g.type === "error").length > before + 1)
    expect(!socket.isClosed(), "socket was closed by a bad frame")
    // Still alive: a good message still echoes.
    const text = `probe-alive-${stamp}`
    socket.send({ type: "message", text })
    const echo = await socket.next((f) => f.type === "message" && f.text === text)
    expect(echo.role === "visitor", "echo missing after bad frames")
  })

  await check("a burst of 100 typing frames is absorbed without a disconnect", async () => {
    for (let i = 0; i < 100; i++) socket.send({ type: "typing", active: i % 2 === 0 })
    const text = `probe-after-flood-${stamp}`
    socket.send({ type: "message", text })
    await socket.next((f) => f.type === "message" && f.text === text)
    expect(!socket.isClosed(), "socket closed under a typing flood")
    socket.close()
  })
  } // conversationA1 !== null
  //#endregion

  //#region H. The internal API — SSRF payloads and the credential read-back
  // The dashboard's server-to-server surface. Only reachable with the shared
  // secret, which is the admin key: CI's throwaway stack has one, production
  // must never hand one to a probe. Every request here is REFUSED before any
  // network egress — that is the property under test — so nothing in this
  // section talks to a real provider or crawls a real site.
  console.log("\n[H] internal API")
  if (!internalSecret) {
    skip("[H] internal API checks", "INTERNAL_API_SECRET not in the environment (CI sets a throwaway one; never point this at production with the real one)")
  } else {
    const secretHeader = { "x-internal-secret": internalSecret }
    const internal = (path, body, headers = secretHeader) =>
      body === undefined
        ? request(path, { headers })
        : postJson(path, body, headers, { patient: false })

    await check("a secretless request and a WRONG secret are the same empty 401", async () => {
      const none = await request(`/internal/orgs/${orgA.id}/credentials`)
      const wrong = await request(`/internal/orgs/${orgA.id}/credentials`, { headers: { "x-internal-secret": "x".repeat(internalSecret.length) } })
      expect(none.status === 401 && wrong.status === 401, `statuses ${none.status}/${wrong.status}`)
      const [n, w] = [await none.text(), await wrong.text()]
      expect(n === w, `bodies differ: ${JSON.stringify(n)} vs ${JSON.stringify(w)}`)
      expect(n.length === 0, `401 body is not empty: ${JSON.stringify(n)}`)
    })

    await check("an unknown org and a malformed org id are both 404 — with the secret", async () => {
      const unknown = await internal(`/internal/orgs/org_00000000000000000000000000000000/credentials`)
      const malformed = await internal(`/internal/orgs/not-an-org/credentials`)
      expect(unknown.status === 404 && malformed.status === 404, `statuses ${unknown.status}/${malformed.status}`)
    })

    if (fixture.credentialCanary) {
      await check("READ-BACK DENIAL: the credential status shows a suffix and never the key or its ciphertext", async () => {
        // The one row whose plaintext this probe knows. The status route may
        // show the last four characters — that is the display contract — and
        // must show nothing else of it, in any form.
        const canary = fixture.credentialCanary
        const res = await internal(`/internal/orgs/${fixture.orgs.c.id}/credentials`)
        expect(res.status === 200, `status ${res.status}`)
        const body = await res.text()
        expect(body.includes(canary.slice(-4)), "the suffix is not shown — is this the seeded row?")
        expect(!body.includes(canary), "THE PLAINTEXT KEY IS IN THE STATUS RESPONSE")
        expect(!body.includes(canary.slice(0, -4)), "the key minus its suffix is in the status response")
        expect(!body.includes("probe_canary"), "a recognizable fragment of the key is in the status response")
        expect(!/key_ciphertext|"v1\.[A-Za-z0-9+/=]+\./.test(body), "ciphertext material is in the status response")
      })
    } else {
      skip("credential read-back denial", "the fixture has no canary (CREDENTIAL_MASTER_KEY was unset when it was seeded)")
    }

    // Every payload the SSRF guard exists for, in both places a tenant can
    // hand this server a URL: a crawl target, and a self-hosted provider's
    // base URL. Each must be refused with the ONE generic sentence — which
    // private range it landed in is reconnaissance — and refused before any
    // fetch: nothing here has a listener, and a probe that hung would be
    // the finding.
    const SSRF_URLS = [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://0x7f000001/",
      "http://2130706433/",
      "http://0.0.0.0/",
      "http://localhost/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[fd00::1]/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://metadata.google.internal/",
    ]

    await check(`SSRF in crawl targets: ${SSRF_URLS.length} private, loopback, link-local and exotic addresses all refused as non-public`, async () => {
      for (const location of SSRF_URLS) {
        const res = await internal(`/internal/orgs/${orgA.id}/sources`, { kind: "url", location })
        const body = await res.text()
        expect(res.status === 422, `${location} → ${res.status} ${body}`)
        expect(body.includes("public address"), `${location} refused for another reason: ${body}`)
      }
    })

    await check("SSRF in crawl targets: non-http schemes and embedded credentials are refused by their own rule", async () => {
      // Different sentences from the vet's: these never reach DNS, and the
      // probe asserts they are refused for what they are.
      const file = await internal(`/internal/orgs/${orgA.id}/sources`, { kind: "url", location: "file:///etc/passwd" })
      expect(file.status === 422 && (await file.text()).includes("http(s)"), "file: URL not refused by scheme")
      const creds = await internal(`/internal/orgs/${orgA.id}/sources`, { kind: "url", location: "http://user:pw@example.com/" })
      expect(creds.status === 422 && (await creds.text()).includes("credentials"), "embedded credentials not refused")
    })

    await check(`SSRF in self-hosted provider base URLs (Ollama and OpenAI-compatible): all ${SSRF_URLS.length} refused before any request leaves`, async () => {
      for (const [i, baseUrl] of SSRF_URLS.entries()) {
        const body = i % 2 === 0
          ? { role: "generation", provider: "ollama", model: "llama3.2", baseUrl, save: false }
          : { role: "generation", provider: "openai_compatible", model: "any", apiKey: "sk-probe-not-a-real-key-000000", baseUrl, save: false }
        const res = await internal(`/internal/orgs/${orgA.id}/credentials`, body)
        const text = await res.text()
        expect(res.status === 422, `${baseUrl} → ${res.status} ${text}`)
        expect(text.includes("public address"), `${baseUrl} refused for another reason: ${text}`)
      }
    })

    await check("a refused credential's error never echoes the key that was sent", async () => {
      // A refusal is the path most likely to be logged and shown; the key
      // must not ride along in it.
      const key = "sk-probe-INJECTED-must-not-echo-9f3a"
      const res = await internal(`/internal/orgs/${orgA.id}/credentials`, {
        role: "generation", provider: "openai_compatible", model: "any", apiKey: key,
        baseUrl: "http://169.254.169.254/v1", save: false,
      })
      const text = await res.text()
      expect(res.status === 422, `status ${res.status}`)
      expect(!text.includes(key) && !text.includes("INJECTED"), `the key was echoed: ${text}`)
    })

    await check("shape violations are refused with a sentence, and nothing was stored", async () => {
      // A control that the route parses rather than refusing everything:
      // these are refused for SHAPE, with different sentences than the vet's.
      const noKey = await internal(`/internal/orgs/${orgB.id}/credentials`, { role: "generation", provider: "groq", save: true })
      expect(noKey.status === 422 && (await noKey.text()).includes("API key"), "groq without a key not refused for shape")
      const badRole = await internal(`/internal/orgs/${orgB.id}/credentials`, { role: "root", provider: "groq", apiKey: "gsk_x".padEnd(40, "0"), save: true })
      expect(badRole.status === 422 && (await badRole.text()).includes("role"), "bad role not refused for shape")
      const status = await internal(`/internal/orgs/${orgB.id}/credentials`)
      const body = await status.json()
      expect(Array.isArray(body.credentials) && body.credentials.length === 0, `something was stored on org B: ${JSON.stringify(body)}`)
    })

    await check("the browser cannot read the internal API cross-origin — no CORS headers on any answer", async () => {
      const res = await request(`/internal/orgs/${orgB.id}/credentials`, { headers: { ...secretHeader, origin: orgB.origin } })
      expect(res.status === 200, `status ${res.status}`)
      expect(res.headers.get("access-control-allow-origin") === null, "CORS header on an internal response")
    })

    // OVERSIZED UPLOADS — the case the plan's M6 list named and M6.4 could
    // not run, because file uploads did not exist yet (§6.3 recorded the
    // debt and said this is where it belongs). M7.6b built the route; this
    // is the check.
    //
    // The property is not just "a big body is refused" but WHERE: before the
    // parser. A PDF parser is the largest attack surface in the ingest path
    // — it decompresses — so a service that streamed 11 MB into pdf.js and
    // refused afterwards would have already done the expensive thing.
    const uploadBytes = (bytes, filename, type = "application/pdf") =>
      request(`/internal/orgs/${orgA.id}/sources/upload`, {
        method: "POST",
        headers: {
          ...secretHeader,
          "content-type": "application/octet-stream",
          "x-upload-filename": encodeURIComponent(filename),
          "x-upload-content-type": type,
        },
        body: bytes,
      }, 60_000)

    await check("an oversized upload is refused 413, and refused BEFORE the parser runs", async () => {
      // A valid PDF header with 11 MB behind it: the ONLY thing that can
      // reject this is the size cap. If the cap were missing, pdf.js would
      // run on 11 MB of padding and answer something else entirely.
      const oversized = new Uint8Array(11 * 1024 * 1024 + 16)
      oversized.set(new TextEncoder().encode("%PDF-1.7\n"), 0)
      oversized.fill(0x20, 9)
      const started = Date.now()
      const res = await uploadBytes(oversized, "oversized.pdf")
      const body = await res.text()
      expect(res.status === 413, `status ${res.status}: ${body.slice(0, 200)}`)
      // The sentence names the limit, because this one is the tenant's to
      // act on — unlike the uniform refusals an outsider could probe.
      expect(/larger than \d+ MB/.test(body), `413 does not name the limit: ${body.slice(0, 200)}`)
      // A parse of 11 MB would not be instant. This is a smell test, not a
      // proof, and it is written as one: generous enough never to flake on a
      // loaded CI runner, tight enough that a full parse would trip it.
      const elapsed = Date.now() - started
      expect(elapsed < 30_000, `refusal took ${elapsed} ms — did the parser run first?`)
    })

    await check("an upload the parser cannot read is refused with a sentence, never a 500", async () => {
      // Bytes claiming to be a PDF and not being one, an empty file, and a
      // nameless one. Each must be a 422 the tenant can act on — a 500 here
      // would mean an unhandled parser throw reached the top of the route,
      // which is how a malformed file becomes a denial of service.
      //
      // That nothing was STORED is asserted by the unit suite
      // (internalSources.test.ts counts the org's sources across every
      // refusal) rather than here: this surface has no sources read route —
      // the dashboard reads that table straight from Postgres (§9.9) — so a
      // black-box probe cannot observe it, and pretending otherwise would be
      // a check that passes because it looks at nothing.
      const broken = await uploadBytes(new TextEncoder().encode("%PDF-1.7\nnot actually a pdf"), "broken.pdf")
      const body = await broken.text()
      expect(broken.status === 422, `broken pdf → ${broken.status}: ${body.slice(0, 200)}`)
      const empty = await uploadBytes(new Uint8Array(0), "empty.md", "text/markdown")
      expect(empty.status === 422, `empty file → ${empty.status}`)
      const nameless = await uploadBytes(new TextEncoder().encode("# Doc\n\nText.\n"), "", "text/markdown")
      expect(nameless.status === 422, `nameless file → ${nameless.status}`)
    })

    await check("an upload without the secret is the same empty 401 as every other internal call", async () => {
      const res = await request(`/internal/orgs/${orgA.id}/sources/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-upload-filename": "doc.md",
          "x-upload-content-type": "text/markdown",
        },
        body: new TextEncoder().encode("# Doc\n\nText.\n"),
      })
      expect(res.status === 401, `status ${res.status}`)
      expect((await res.text()).length === 0, "401 body is not empty")
    })
  }
  //#endregion

  //#region I. Layer 6 — server-side sessions with the secret key (M7.3)
  // POST /v1/sessions: the customer's OWN backend presents the secret key to
  // mint a session for a user it signed in. What must hold: every wrong key
  // is one uniform 401 (a revoked secret indistinguishable from an unknown
  // one, and the PUBLISHABLE key refused here); the secret key is refused
  // where the publishable one belongs; the origin still has to be
  // allowlisted; identity lives in a namespace a browser cannot claim; and
  // the route never speaks CORS, so a secret key on a page cannot work even
  // by mistake. Every check has its positive control: the real key on the
  // real origin mints, and that token chats.
  console.log("\n[I] server-side sessions (secret key)")
  if (!orgA.secretKey) {
    skip("[I] server-side session checks", "fixture predates M7.3 (no secretKey) — re-run npm run seed-security")
  } else {
    const serverMint = (body, bearer, extraHeaders = {}) => postJson("/v1/sessions", body, {
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...extraHeaders,
    })
    const identified = `probe_user_${stamp}`

    let unknownSecretBody = null
    await check("a missing, garbage, unknown, and REVOKED secret key are one byte-identical 401 with no CORS", async () => {
      const unknown = await serverMint({ origin: orgA.origin, visitorId: identified }, `sk_live_${"0".repeat(32)}`)
      expect(unknown.status === 401, `unknown: status ${unknown.status}`)
      expect(unknown.headers.get("access-control-allow-origin") === null, "CORS header on the refusal")
      unknownSecretBody = await unknown.text()
      for (const [label, bearer] of [["missing", null], ["garbage", "not-a-key"], ["revoked", orgA.revokedSecretKey]]) {
        const res = await serverMint({ origin: orgA.origin, visitorId: identified }, bearer)
        expect(res.status === 401, `${label}: status ${res.status}`)
        expect((await res.text()) === unknownSecretBody, `${label}: body differs from the unknown-key answer`)
      }
    })

    await check("the PUBLISHABLE key is refused as a bearer here, and the SECRET key is refused where the publishable one belongs", async () => {
      // The two credentials are told apart by shape before any lookup: each
      // presented in the other's place is refused for what it looks like.
      const pkHere = await serverMint({ origin: orgA.origin, visitorId: identified }, orgA.publishableKey)
      expect(pkHere.status === 401, `pk as bearer: status ${pkHere.status}`)
      expect((await pkHere.text()) === unknownSecretBody, "pk-as-bearer body differs from the unknown-key answer")
      const skThere = await postJson("/v1/widget/session", { publishableKey: orgA.secretKey }, { origin: orgA.origin })
      expect(skThere.status === 401, `sk as publishable key: status ${skThere.status}`)
      expect((await skThere.text()) === unknownKeyBody, "sk-as-pk body differs from the unknown-pk answer")
    })

    await check("a valid secret key naming an UNLISTED origin is refused with 403 and no CORS — the allowlist still decides", async () => {
      const res = await serverMint({ origin: "https://thief.example", visitorId: identified }, orgA.secretKey)
      expect(res.status === 403, `status ${res.status}`)
      expect(res.headers.get("access-control-allow-origin") === null, "CORS header on the refusal")
      const body = await res.json()
      expect(body.error === "origin not allowed", `error ${body.error}`)
    })

    await check("an anonymous-shaped visitorId (vis_…) is refused with 400 — that namespace is the browser's", async () => {
      const res = await serverMint({ origin: orgA.origin, visitorId: anonymousVisitor() }, orgA.secretKey)
      expect(res.status === 400, `status ${res.status}`)
      const body = await res.json()
      expect(body.token === undefined, "a token was minted for a refused visitor id")
    })

    let serverSession = null
    await check("CONTROL: the real key, the allowlisted origin, and a user id mint a session — with no CORS on the answer", async () => {
      const res = await serverMint({ origin: orgA.origin, visitorId: identified }, orgA.secretKey)
      // Read ONCE, then assert: a template literal that awaited res.text()
      // inside the failure message would consume the body even on success,
      // and the parse below would then fail a check that had passed. (The
      // first run of this section failed exactly that way.)
      const text = await res.text()
      expect(res.status === 200, `status ${res.status} ${text}`)
      expect(res.headers.get("access-control-allow-origin") === null, "CORS header on the mint — a page could use a secret key")
      serverSession = JSON.parse(text)
      expect(typeof serverSession.token === "string" && serverSession.token.length > 20, "no token")
      expect(serverSession.visitorId === identified, "visitor id was not the one the server asserted")
    })

    if (serverSession !== null) {
      await check("that token chats from its origin under the asserted identity, and dies replayed from another", async () => {
        const { status, events } = await chat(serverSession, orgA.origin, { question: knownA.text })
        expect(status === 200, `status ${status}`)
        expect(events.some((e) => e.type === "claim"), `no claim (got ${events.map((e) => e.type).join(",")})`)
        const replayed = await postJson("/v1/widget/chat", { question: "hello" }, { origin: "https://thief.example", ...bearer(serverSession) })
        expect(replayed.status === 403, `replay status ${replayed.status}`)
      })
    }

    await check("the browser route refuses that same user id — a copied snippet cannot impersonate a server-identified user", async () => {
      // The impersonation the namespace split exists to stop: anyone on the
      // allowlisted origin minting "as" the user the server just identified.
      const res = await postJson("/v1/widget/session", { publishableKey: orgA.publishableKey, visitorId: identified }, { origin: orgA.origin })
      expect(res.status === 400, `status ${res.status}`)
    })

    await check("a browser preflight to the secret-key route is granted nothing", async () => {
      const res = await request("/v1/sessions", {
        method: "OPTIONS",
        headers: { origin: orgA.origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
      })
      expect(res.headers.get("access-control-allow-origin") === null, `preflight granted ${res.headers.get("access-control-allow-origin")}`)
    })
  }
  //#endregion

  //#region G. Rate limits — LAST, because they drain the buckets
  console.log("\n[G] rate limits (drains buckets — nothing runs after this)")

  await check("a visitor who chats in a tight loop is told 429 WITH CORS headers — the widget can render it", async () => {
    let limited = null
    for (let i = 0; i < 12 && limited === null; i++) {
      const res = await postJson("/v1/widget/chat", { question: `flood ${i}` }, { origin: orgB.origin, ...bearer(sessionB1) }, { patient: false })
      if (res.status === 429) limited = res
      else await res.arrayBuffer()
    }
    expect(limited !== null, "no 429 within 12 rapid chats")
    expect(limited.headers.get("access-control-allow-origin") === orgB.origin, "429 lacked the CORS echo")
  })

  await check("an IP that mints sessions in a tight loop is told 429", async () => {
    let limited = false
    for (let i = 0; i < 30 && !limited; i++) {
      const res = await postJson("/v1/widget/session", { publishableKey: orgA.publishableKey }, { origin: orgA.origin }, { patient: false })
      if (res.status === 429) limited = true
      else await res.arrayBuffer()
    }
    expect(limited, "no 429 within 30 rapid mints")
  })

  await check("an IP that guesses at secret keys in a tight loop is told 429 (M7.3)", async () => {
    // The server-mint bucket is deliberately more generous than the browser
    // one (a customer's backend mints for many users) — but it exists, and
    // it bounds a flood of guesses before each one costs a hash and a
    // lookup. Sent in parallel: the bucket refills at one per second, and a
    // sequential loop of 401s could refill it faster than it drains.
    const statuses = await Promise.all(Array.from({ length: 90 }, () =>
      postJson("/v1/sessions", { origin: orgA.origin, visitorId: "guesser" }, { authorization: "Bearer sk_live_guess" }, { patient: false })
        .then(async (res) => { await res.arrayBuffer(); return res.status })))
    expect(statuses.includes(429), `no 429 within 90 rapid guesses (${[...new Set(statuses)].join(",")})`)
  })

  await check("the service is still healthy after the floods", async () => {
    const res = await request("/api/health")
    expect(res.status === 200, `health ${res.status}`)
  })
  //#endregion
}

console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`)
if (failures > 0) {
  console.error(`\n${failures} security check(s) failed`)
  process.exit(1)
}
console.log("all security checks passed")
