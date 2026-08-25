// Time-to-first-token against a DEPLOYED stack, cold and warm — the last
// metric in the plan's latency list with no producer, and the one that can
// only be measured against a real deployment (Render's container wake and
// Neon's autosuspend are the whole point).
//
// Zero dependencies, Node 22 stdlib only, like every sibling probe: it runs
// with no npm install and can be pointed at any deployment.
//
// What it measures, and why each number is separate:
//   mint  — POST /v1/widget/session. On a COLD stack this is where the
//           container wake lands, so it is reported apart from the answer
//           rather than folded into it. It is also the handshake that warms
//           Neon while a visitor types (the free-tier design's DB-warming
//           path), which is why the chat leg that follows is not paying for
//           the database waking up.
//   ttft  — mint → the first CONTENT event of the answer stream (claim or
//           refusal). Not the first byte: headers flush before retrieval by
//           design (§3.18), so first-byte would measure the flush and not
//           the answer.
//   total — mint → the stream's `done`.
//
// Usage:
//   node scripts/measure-ttft.mjs <baseUrl> <pk> <origin> [--n 5] [--label warm]
//
// COLD runs need the service genuinely idle first (Render spins down after
// ~15 minutes). Each run spends one answer against the org's daily cap.

const args = process.argv.slice(2)
const [baseUrl, pk, origin] = args
if (!baseUrl || !pk || !origin) {
  console.error("usage: node scripts/measure-ttft.mjs <baseUrl> <pk> <origin> [--n 5] [--label warm]")
  process.exit(1)
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const N = Number(flag("n", "5"))
const LABEL = flag("label", "warm")
const QUESTION = flag("question", "How do I register a Fastify plugin?")

const base = baseUrl.replace(/\/$/, "")

/** One full visitor round trip: mint a session, ask, read the stream. */
async function once() {
  const t0 = Date.now()
  const mintRes = await fetch(`${base}/v1/widget/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ publishableKey: pk }),
  })
  const mintMs = Date.now() - t0
  if (!mintRes.ok) return { ok: false, stage: "mint", status: mintRes.status, detail: (await mintRes.text()).slice(0, 200), mintMs }
  const { token } = await mintRes.json()

  const t1 = Date.now()
  const chatRes = await fetch(`${base}/v1/widget/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: QUESTION }),
  })
  if (!chatRes.ok) return { ok: false, stage: "chat", status: chatRes.status, detail: (await chatRes.text()).slice(0, 200), mintMs }

  let ttftMs = null
  let kinds = []
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of chatRes.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith("data:")) continue
      let event
      try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
      kinds.push(event.type)
      // First CONTENT event, not first byte: meta is emitted before the
      // model is called, so counting it would report the flush.
      if (ttftMs === null && (event.type === "claim" || event.type === "refusal" || event.type === "error")) {
        ttftMs = Date.now() - t1
      }
    }
  }
  return { ok: true, mintMs, ttftMs, totalMs: Date.now() - t1, kinds }
}

const pct = (xs, p) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}

const runs = []
for (let i = 1; i <= N; i++) {
  const r = await once()
  if (!r.ok) {
    console.log(`  run ${i}: FAILED at ${r.stage} (HTTP ${r.status}) ${r.detail ?? ""}`)
  } else {
    console.log(`  run ${i}: mint ${r.mintMs} ms · ttft ${r.ttftMs} ms · total ${r.totalMs} ms · [${r.kinds.join(" ")}]`)
  }
  runs.push(r)
  // A pause between runs so the per-visitor token bucket is never what is
  // being measured.
  if (i < N) await new Promise((r) => setTimeout(r, 3000))
}

const ok = runs.filter((r) => r.ok)
console.log(`\n${LABEL}: ${ok.length}/${runs.length} runs completed`)
if (ok.length > 0) {
  const mints = ok.map((r) => r.mintMs)
  const ttfts = ok.map((r) => r.ttftMs).filter((x) => x !== null)
  const totals = ok.map((r) => r.totalMs)
  console.log(`  mint   p50 ${pct(mints, 50)} ms   max ${Math.max(...mints)} ms`)
  console.log(`  ttft   p50 ${pct(ttfts, 50)} ms   p95 ${pct(ttfts, 95)} ms`)
  console.log(`  total  p50 ${pct(totals, 50)} ms   p95 ${pct(totals, 95)} ms`)
}
