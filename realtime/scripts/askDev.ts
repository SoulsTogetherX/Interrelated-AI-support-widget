//#region Imports
// Dev-only CLI: drives the FULL grounded-answer pipeline — retrieve → gate →
// prompt → LLM → parse → verify → strip → persist — against ingested
// content, so the M2 loop is drivable by hand before the SSE route and
// widget exist.
//
//   npm run ask -- "how do refunds work" [--org "Name"] [--conversation con_…]
//
// Glue over answerQuestion(), same rule as the sibling CLIs: no logic of its
// own to drift. The LLM is the deterministic mock in RESPONDER mode: it
// parses the [chunk …] blocks out of the prompt it receives and answers by
// quoting the opening of each of the top chunks — grounded by construction,
// so verification PASSES and the whole loop (including citations and
// persistence) is observable with zero API keys. Real providers plug into
// the same seam in M2.4.
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

  const embedder = process.env.EMBEDDING_PROVIDER === "local"
    ? new (await import("@providers/embedding/local")).LocalEmbeddingProvider()
    : new MockEmbeddingProvider()

  // The context-quoting responder: finds each "[chunk chk_… | url …]" block
  // in the user turn and claims the first sentence-ish span of the two best
  // chunks, verbatim. Deliberately simple — its only job is producing claims
  // that VERIFY, so the strip path stays observable by corrupting one quote
  // with --tamper.
  const tamper = args.includes("--tamper")
  const llm = new MockLLMProvider((request) => {
    const user = request.messages.at(-1)?.content ?? ""
    const blocks = [...user.matchAll(/\[chunk (chk_[0-9a-z]{32}) \|[^\]]*\]\n([^\n]+)/g)]
    const claims = blocks.slice(0, 2).map(([, chunkId, firstLine], i) => {
      const quote = (firstLine as string).slice(0, 90)
      return {
        text: `According to the documentation: ${quote}`,
        chunkId: chunkId as string,
        quote: tamper && i === 0 ? `${quote} (embellished)` : quote,
      }
    })
    return { text: JSON.stringify({ claims }) }
  })

  const org = await db.selectFrom("organizations").select(["id"]).where("name", "=", orgName).executeTakeFirst()
  if (!org) {
    console.error(`no organization named "${orgName}" — run npm run enqueue first, or pass --org`)
    process.exit(1)
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
  console.log(`claims: ${result.claims.length} total, ${result.claims.filter((c) => c.verdict.status === "verified").length} verified\n`)
  console.log(result.content)
  await db.destroy()
}

main().catch((err) => {
  console.error("ask failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
//#endregion
