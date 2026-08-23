//#region Imports
// Dev-only CLI: drives the FULL grounded-answer pipeline — retrieve → gate →
// prompt → LLM → parse → verify → strip → persist — against ingested
// content, so the M2 loop is drivable by hand before the SSE route and
// widget exist.
//
//   npm run ask -- "how do refunds work" [--org "Name"] [--conversation con_…]
//                  [--llm mock|groq|gemini|ollama|anthropic] [--tamper]
//
// Glue over answerQuestion(), same rule as the sibling CLIs: no logic of its
// own to drift. The default LLM is the deterministic mock in RESPONDER
// mode: it parses the [chunk …] blocks out of the prompt it receives and
// answers by quoting the opening of each of the top chunks — grounded by
// construction, so verification PASSES and the whole loop (including
// citations and persistence) is observable with zero API keys. --llm picks
// a real provider instead, configured by the GROQ_/GEMINI_/OLLAMA_/
// ANTHROPIC_ vars documented in .env.example — the first place real model
// output meets the verifier, ahead of the M2.5 route. (`--llm anthropic`
// is the one that costs money on every run; it has no free tier.)
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
//#endregion

//#region Env fallback
// Same fallback as the sibling CLIs: pull Postgres vars from the repo-root
// .env when unset. Must happen BEFORE @/db/pool loads (it reads env at
// module load), hence the deferred imports in main().
if (!process.env.POSTGRES_PASSWORD) {
  try {
    const envFile = readFileSync(resolve(__dirname, "../../.env"), "utf8")
    for (const line of envFile.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (match && process.env[match[1] as string] === undefined) {
        process.env[match[1] as string] = match[2] as string
      }
    }
  } catch {
    // No .env — the pool will fail to connect and say so below.
  }
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const question = args.find((a) => !a.startsWith("--"))
  if (!question) {
    console.error('usage: npm run ask -- "<question>" [--org "Name"] [--conversation con_…]')
    process.exit(1)
  }
  const orgName = args.includes("--org") ? (args[args.indexOf("--org") + 1] ?? "Local Dev Org") : "Local Dev Org"
  const conversationId = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : undefined

  const { db } = await import("@/db/pool")
  const { answerQuestion } = await import("@/answer/pipeline")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")
  const { MockLLMProvider } = await import("@providers/llm/mock")
  const { buildLLMProvider } = await import("@/answer/buildLLM")
  const { groundedMockResponder } = await import("@/answer/mockResponder")

  const fallbackEmbedder = process.env.EMBEDDING_PROVIDER === "local"
    ? new (await import("@providers/embedding/local")).LocalEmbeddingProvider()
    : new MockEmbeddingProvider()

  // Provider selection shares server boot's table (answer/buildLLM.ts) —
  // one place to know how env config maps to providers. The lone CLI
  // special case is --tamper, which needs its own responder instance to
  // corrupt a quote; a missing key throws a one-line usage error below.
  const tamper = args.includes("--tamper")
  const llmChoice = args.includes("--llm") ? (args[args.indexOf("--llm") + 1] ?? "mock") : "mock"
  const llm = tamper && llmChoice === "mock"
    ? new MockLLMProvider(groundedMockResponder(true))
    : buildLLMProvider(llmChoice)

  const org = await db.selectFrom("organizations").select(["id"]).where("name", "=", orgName).executeTakeFirst()
  if (!org) {
    console.error(`no organization named "${orgName}" — run npm run enqueue first, or pass --org`)
    process.exit(1)
  }

  // Same resolution the chat route does (§3.18): if this org has a BYO
  // embedding credential, the question MUST be embedded by that model or
  // the dense arm searches a space its chunks are not in — and the CLI
  // would report a refusal that looks like a retrieval bug.
  const { resolveEmbeddingProvider } = await import("@/credentials/resolve")
  const embedder = (await resolveEmbeddingProvider(db, org.id)) ?? fallbackEmbedder
  if (embedder !== fallbackEmbedder) {
    console.log(`using the org's saved embedding model: ${embedder.model}`)
  }

  const result = await answerQuestion({
    db, embedder, llm,
    orgId: org.id,
    visitorId: "cli-dev",
    question,
    ...(conversationId !== undefined ? { conversationId } : {}),
    onEvent: (event) => console.log(`event  ${JSON.stringify(event)}`),
  })

  console.log(`\nconversation ${result.conversationId}  (pass --conversation to continue it)`)
  console.log(`refused=${result.refused}  ttft=${result.ttftMs}ms  total=${result.totalMs}ms`)
  // Tokens and their list-price cost (M5.2) — the cost metric drivable by
  // hand, the same way --tamper makes the strip path observable. "unpriced"
  // is the honest output for a self-hosted model, never $0.00; "not
  // reported" is a provider that streamed no usage, which is a different
  // silence and says so.
  if (result.usage === null) {
    console.log("tokens: not reported by this provider")
  } else {
    const { costUsd } = await import("@shared/pricing/models")
    const cost = costUsd(llm.model, result.usage.inputTokens, result.usage.outputTokens)
    const priced = cost === null ? "unpriced model" : `$${cost.toFixed(6)} at list price`
    console.log(`tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out  (${priced})`)
  }
  console.log(`claims: ${result.claims.length} total, ${result.claims.filter((c) => c.verdict.status === "verified").length} verified\n`)
  console.log(result.content)
  await db.destroy()
}

main().catch((err) => {
  // Duck-typed rather than instanceof so the check needs no import at this
  // scope: a 429 is the routine free-tier experience and deserves a human
  // sentence (the M2.5 queue turns this into a "one moment" state).
  if (err instanceof Error && err.name === "LLMHttpError") {
    const status = (err as { status?: number }).status
    const retryAfterMs = (err as { retryAfterMs?: number | null }).retryAfterMs
    if (status === 429) {
      console.error(`rate limited by the provider${retryAfterMs ? ` — retry in ${Math.ceil(retryAfterMs / 1000)}s` : ""}`)
      process.exit(1)
    }
  }
  // The answer deadline (M8.4): the provider accepted the call and then
  // never answered inside DEFAULT_ANSWER_DEADLINE_MS. Named, because the
  // bare DOMException message does not say WHOSE timeout fired, and a
  // developer probing a slow self-hosted model would otherwise grep for a
  // timeout this CLI never set.
  if (err instanceof Error && err.name === "TimeoutError") {
    console.error("the provider did not answer inside the pipeline's deadline (ANSWER_DEADLINE_MS, 60s default) — it accepted the call and went quiet")
    process.exit(1)
  }
  console.error("ask failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
//#endregion
