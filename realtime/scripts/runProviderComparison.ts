//#region Why this file
// The harness half of the provider comparison (M8.3) — `npm run compare`.
//
//   npm run compare -- [--providers mock,gemini,groq,ollama,anthropic]
//                      [--questions N] [--embedder local|gemini]
//                      [--pace-ms N] [--json]
//
// The plan's provider table is the last of its named metrics with no
// producer: "the same eval run across every provider — recall@5,
// citation-verification rate, schema-violation rate, p50 TTFT, cost per 1k
// answers". recall@5 belongs to the EMBEDDING provider and is produced by
// runEval's --embedder flag (§3.14); the other four belong to the
// GENERATION provider and are produced here. eval/providerComparison.ts
// owns the arithmetic, this file owns the Postgres and the network — the
// split runEval/metrics.ts and runTenantScan/tenantScan.ts already use, and
// for the same reason: the numbers get published, so the part that can be
// wrong in a way a test would catch is pure.
//
// Three decisions carry it.
//
// **It drives the REAL pipeline** (`answerQuestion`, §3.15.3) rather than
// calling providers directly. What the plan wants compared is not raw model
// output but what this PRODUCT does with it — retrieve, gate, prompt,
// stream, parse, verify, strip, persist — because the citation-verification
// and strip rates are properties of that whole path, and a harness that
// called `stream()` itself would be measuring a different program from the
// one the widget runs. It is also why the schema-violation count is READ
// BACK from `messages.schema_violations` (§3.3.12) instead of counted
// privately: the published number is then the product's own record, and the
// column M7.10 added is proven end to end rather than asserted.
//
// **The pipeline's retry policy is left alone.** §3.15.5 sets it from a
// product judgment — three attempts inside 8 seconds, because that is how
// long someone watches a chat bubble — and a harness that widened it to
// flatter a free tier would publish a latency no visitor will ever see.
// So the harness paces ITSELF instead (--pace-ms), staying under the free
// tier's requests-per-minute rather than manufacturing rate limits a real
// tenant's traffic would not produce; a 429 that survives the visitor's own
// budget is recorded as the `error` outcome it really is.
//
// **Every provider named gets a row, including the ones with no key.** The
// key-gated idiom this repo uses everywhere (§3.8, §2.4.5c): a provider
// that could not run says so on its own line, because "gated off" silently
// omitted is indistinguishable from "passed".
//
// One fairness rule, enforced rather than documented: every generation
// provider is compared over the SAME embedder and the SAME questions in the
// same order. Retrieval is what decides which chunks a model is asked to
// ground in, so letting it vary between rows would confound the comparison
// with the thing runEval measures separately.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
//#endregion

//#region Env fallback
// Same fallback as the sibling CLIs (§3.11): pull Postgres and provider
// vars from the repo-root .env when unset. Must happen BEFORE @/db/pool
// loads (it reads env at module load), hence the deferred imports in main().
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

//#region Constants
/** The org runEval ingests into. The comparison MUST run over that corpus:
 *  it is the one whose retrieval quality is already measured and published,
 *  so a generation number produced over it can be read beside a recall
 *  number produced over it. */
const EVAL_ORG_NAME = "EVAL HARNESS (do not use)"

/** Where the run's RAW per-question outcomes land, beside runEval's own
 *  droppings and gitignored with them (§7). Written because the harness
 *  deletes its conversations when it finishes: without this the published
 *  table would be a set of summary statistics whose underlying data no
 *  longer exists anywhere, which is exactly the "it works well in my
 *  testing" the anti-tutorial rules refuse. An outlier — one answer that
 *  took five minutes to its first token — is only diagnosable if the run
 *  that saw it wrote down which question it was. */
const RESULTS_DIR = resolve(__dirname, "../../eval/results")

/** Every provider the product can build (§3.15.4's table). Named in full
 *  rather than derived from the environment, so a provider with no key
 *  appears as a skipped row instead of vanishing. */
const ALL_PROVIDERS = ["mock", "gemini", "groq", "ollama", "anthropic"] as const

/** Default question count. Deliberately a subset of the 80-question golden
 *  set: one question is one model call, the free tiers this product is
 *  designed around allow 10–15 per minute, and a measured TTFT p95 of 27.9 s
 *  (§2.4.5h) makes the full set hours per provider. The published table
 *  states its n, and --questions raises it for anyone with quota to spend. */
const DEFAULT_QUESTIONS = 20

/** Seconds between questions, per provider. 6 s ≈ 10 requests/minute, which
 *  is the floor of the free tiers named above. `mock` overrides it to 0 —
 *  there is nothing to be polite to. */
const DEFAULT_PACE_MS = 6_000
//#endregion

//#region Types
interface GoldenEntry {
  id: string
  style: string
  question: string
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i === -1 ? undefined : args[i + 1]
  }

  const providers = (flag("--providers") ?? ALL_PROVIDERS.join(",")).split(",").map((p) => p.trim()).filter(Boolean)
  const questionCount = Number(flag("--questions") ?? DEFAULT_QUESTIONS)
  const embedderChoice = flag("--embedder") ?? "local"
  const paceMs = Number(flag("--pace-ms") ?? DEFAULT_PACE_MS)
  const asJson = args.includes("--json")

  if (!Number.isInteger(questionCount) || questionCount < 1) {
    console.error(`--questions must be a positive integer, got "${flag("--questions")}"`)
    process.exit(1)
  }
  if (embedderChoice !== "local" && embedderChoice !== "gemini") {
    console.error(`--embedder must be local or gemini (got "${embedderChoice}") — the same choices runEval offers`)
    process.exit(1)
  }
  for (const p of providers) {
    if (!(ALL_PROVIDERS as readonly string[]).includes(p)) {
      console.error(`unknown provider "${p}" — one of ${ALL_PROVIDERS.join(", ")}`)
      process.exit(1)
    }
  }

  const { db } = await import("@/db/pool")
  const { migrateToLatest } = await import("@/db/migrate")
  const { answerQuestion, AnswerSchemaError } = await import("@/answer/pipeline")
  const { buildLLMProvider } = await import("@/answer/buildLLM")
  const { costUsd, PRICES_AS_OF } = await import("@shared/pricing/models")
  const { summarizeProvider } = await import("@eval/providerComparison")
  const { LocalEmbeddingProvider } = await import("@providers/embedding/local")
  type AnswerOutcome = import("@eval/providerComparison").AnswerOutcome
  type ProviderSummary = import("@eval/providerComparison").ProviderSummary

  await migrateToLatest(db)

  // The embedder is fixed for the whole sweep — the fairness rule above.
  const embedder = embedderChoice === "gemini"
    ? new (await import("@providers/embedding/gemini")).GeminiEmbeddingProvider({
        apiKey: process.env.GEMINI_API_KEY as string,
        ...(process.env.GEMINI_EMBED_MODEL ? { model: process.env.GEMINI_EMBED_MODEL } : {}),
      })
    : new LocalEmbeddingProvider()
  if (embedderChoice === "gemini" && !process.env.GEMINI_API_KEY) {
    console.error("--embedder gemini needs GEMINI_API_KEY (see .env.example)")
    process.exit(1)
  }

  //#region Preconditions
  // The corpus is runEval's to ingest, not this harness's to duplicate — the
  // glue-only rule the sibling CLIs follow (§3.11): a second ingest path
  // would drift from the one whose output is published.
  const org = await db.selectFrom("organizations").select(["id"]).where("name", "=", EVAL_ORG_NAME).executeTakeFirst()
  if (!org) {
    console.error(`no "${EVAL_ORG_NAME}" org — run \`npm run eval\` first to ingest the corpus`)
    process.exit(1)
  }
  const embedded = await db
    .selectFrom("chunk_embeddings")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", org.id)
    .where("model", "=", embedder.model)
    .executeTakeFirst()
  if (Number(embedded?.n ?? 0) === 0) {
    console.error(
      `the eval corpus has no embeddings under "${embedder.model}" — run ` +
      `\`npm run eval -- --embedder ${embedderChoice}\` first. Asking questions against a corpus ` +
      `this model cannot see would measure the gate refusing, not the provider answering.`,
    )
    process.exit(1)
  }
  //#endregion

  //#region Questions
  const goldenPath = resolve(__dirname, "../../eval/golden.jsonl")
  const golden: GoldenEntry[] = readFileSync(goldenPath, "utf8")
    .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as GoldenEntry)
  // The FIRST n, never a sample: a published comparison has to be
  // re-runnable into the same table, and a random subset would move the
  // numbers between runs for reasons that have nothing to do with the
  // providers.
  const questions = golden.slice(0, questionCount)
  if (questions.length < questionCount) {
    console.log(`note: the golden set has ${golden.length} questions; asking all of them`)
  }
  //#endregion

  console.log(`\nprovider comparison — ${questions.length} questions from the golden set`)
  console.log(`embedder: ${embedder.model} (fixed for every provider)`)
  console.log(`org: ${org.id}   prices as of ${PRICES_AS_OF}\n`)

  //#region The sweep
  const runStamp = Date.now().toString(36)
  const summaries: ProviderSummary[] = []
  const skipped: { provider: string; why: string }[] = []
  /** Every question's outcome, kept for the results file — see RESULTS_DIR. */
  const rawOutcomes: { provider: string; model: string; outcomes: AnswerOutcome[] }[] = []

  for (const providerName of providers) {
    let llm
    try {
      llm = buildLLMProvider(providerName)
    } catch (err) {
      // No key, or no model named for a self-hosted server. A row that says
      // so, never an omission — see the header.
      const why = err instanceof Error ? err.message : String(err)
      skipped.push({ provider: providerName, why })
      console.log(`${providerName.padEnd(10)} SKIPPED — ${why}`)
      continue
    }

    const pace = providerName === "mock" ? 0 : paceMs
    console.log(`${providerName.padEnd(10)} ${llm.model}  (pacing ${pace} ms between questions)`)

    const outcomes: AnswerOutcome[] = []
    for (const [i, entry] of questions.entries()) {
      if (i > 0 && pace > 0) await new Promise((r) => setTimeout(r, pace))
      // A fresh conversation per question: the pipeline appends to a thread,
      // and a shared one would grow the prompt as the run went on, making
      // later questions cost more than earlier ones for no reason a reader
      // could see in the table.
      const visitorId = `cmp_${runStamp}`
      try {
        const result = await answerQuestion({
          db, embedder, llm, orgId: org.id, visitorId, question: entry.question,
        })
        // The product's own record of the contract, not a private counter.
        const row = await db.selectFrom("messages")
          .select(["schema_violations", "model"])
          .where("id", "=", result.messageId)
          .executeTakeFirst()
        const verified = result.claims.filter((c) => c.verdict.status === "verified").length
        const cost = result.usage === null
          ? null
          : costUsd(llm.model, result.usage.inputTokens, result.usage.outputTokens)
        outcomes.push({
          questionId: entry.id,
          outcome: result.refused ? "refused" : "answered",
          claimsTotal: result.claims.length,
          claimsVerified: verified,
          schemaViolations: row?.schema_violations ?? null,
          ttftMs: result.ttftMs,
          totalMs: result.totalMs,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          costUsd: cost,
        })
        process.stdout.write(result.refused ? "r" : verified === result.claims.length ? "." : "s")
      } catch (err) {
        // AnswerSchemaError is the model breaking the JSON contract twice —
        // no assistant row exists to read a count from, which is exactly why
        // it is its own outcome (§3.3.12). Anything else is the provider
        // failing outright: a 401, a rate limit the visitor's budget could
        // not clear, a dropped socket.
        const isContract = err instanceof AnswerSchemaError
        outcomes.push({
          questionId: entry.id,
          outcome: isContract ? "contract_failure" : "error",
          claimsTotal: 0, claimsVerified: 0, schemaViolations: null,
          ttftMs: null, totalMs: 0, inputTokens: null, outputTokens: null, costUsd: null,
        })
        process.stdout.write(isContract ? "X" : "!")
        if (!isContract) {
          const why = err instanceof Error ? err.message.slice(0, 120) : String(err)
          process.stdout.write(`\n  ${entry.id}: ${why}\n`)
        }
      }
    }
    process.stdout.write("\n")
    summaries.push(summarizeProvider(providerName, llm.model, outcomes))
    rawOutcomes.push({ provider: providerName, model: llm.model, outcomes })
  }
  //#endregion

  //#region Cleanup
  // Everything this run created is deleted, including on the failure paths
  // above — §10.3's stance, and here it also keeps the eval org's own
  // published numbers from drifting: a corpus with a thousand harness
  // conversations in it is no longer the corpus RESULTS.md describes.
  const deleted = await db.deleteFrom("conversations")
    .where("org_id", "=", org.id).where("visitor_id", "=", `cmp_${runStamp}`)
    .executeTakeFirst()
  //#endregion

  //#region Report
  const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`)
  const ms = (v: number): string => (Number.isNaN(v) ? "—" : `${Math.round(v)}`)
  const usd = (v: number | null): string => (v === null ? "—" : `$${v.toFixed(4)}`)

  if (asJson) {
    console.log(JSON.stringify({ questions: questions.length, embedder: embedder.model, pricesAsOf: PRICES_AS_OF, summaries, skipped }, null, 2))
  } else {
    console.log("\n" + "=".repeat(112))
    console.log("PROVIDER COMPARISON".padEnd(112))
    console.log("=".repeat(112))
    const head = [
      "provider".padEnd(10), "model".padEnd(26), "ans".padStart(4), "ref".padStart(4),
      "fail".padStart(5), "cite✓".padStart(7), "strip".padStart(7), "viol".padStart(6),
      "ttft p50".padStart(9), "ttft p95".padStart(9), "$/1k".padStart(9),
    ].join(" ")
    console.log(head)
    console.log("-".repeat(112))
    for (const s of summaries) {
      console.log([
        s.provider.padEnd(10), s.model.slice(0, 26).padEnd(26),
        String(s.answered).padStart(4), String(s.refused).padStart(4),
        String(s.contractFailures + s.errors).padStart(5),
        pct(s.citationVerificationRate).padStart(7),
        pct(s.claimStripRate).padStart(7),
        (s.schemaViolationRate === null ? "—" : s.schemaViolationRate.toFixed(2)).padStart(6),
        ms(s.ttftP50Ms).padStart(9), ms(s.ttftP95Ms).padStart(9),
        usd(s.costPer1kAnswersUsd).padStart(9),
      ].join(" "))
    }
    for (const s of skipped) console.log(`${s.provider.padEnd(10)} ${"—".padEnd(26)}  SKIPPED: ${s.why}`)
    console.log("-".repeat(112))
    console.log(`ans/ref/fail = answered / gate-refused / contract-failed+errored, over ${questions.length} questions each.`)
    console.log("cite✓ = claims whose quoted span was found verbatim in the chunk they cited; strip = its complement.")
    console.log("viol = schema violations per generated answer (messages.schema_violations); a contract failure writes no row and lands in `fail`.")
    console.log(`$/1k = list price per 1,000 answers, generation only, prices as of ${PRICES_AS_OF}; "—" = unpriced model or no usage reported.`)
    for (const s of summaries) {
      if (s.unpricedAnswers > 0 && s.answered > 0) {
        console.log(`note: ${s.provider} — ${s.unpricedAnswers} of ${s.answered} answers could not be priced (${s.model} has no row in the price table).`)
      }
      console.log(`      ${s.provider}: ${s.inputTokens} input / ${s.outputTokens} output tokens over ${s.answered} answers.`)
    }
    // The slowest answer, named. At small n the nearest-rank p95 IS the
    // worst sample (rank ceil(0.95 × 19) = 19 of 19), so a single slow
    // stream becomes a headline number — and a reader deserves to know it
    // was one question rather than a tail. Naming it here is what turned a
    // 310-second p95 into a finding instead of a mystery — the finding that
    // became M8.4's deadline, which now bounds this harness too: an answer
    // slower than DEFAULT_ANSWER_DEADLINE_MS (60 s) records as an `error`
    // outcome, exactly as a visitor would have experienced it.
    for (const r of rawOutcomes) {
      const slowest = r.outcomes
        .filter((o) => o.ttftMs !== null)
        .sort((a, b) => (b.ttftMs ?? 0) - (a.ttftMs ?? 0))[0]
      if (slowest && (slowest.ttftMs ?? 0) > 30_000) {
        console.log(
          `slow: ${r.provider} — ${slowest.questionId} reached its first token after ` +
          `${Math.round((slowest.ttftMs ?? 0) / 1000)}s, inside the pipeline's deadline ` +
          `(ANSWER_DEADLINE_MS, 60 s default — §3.15.6) but far past the p50.`,
        )
      }
    }
  }
  // The raw run, written before the summary is trusted — see RESULTS_DIR.
  mkdirSync(RESULTS_DIR, { recursive: true })
  const resultsPath = resolve(RESULTS_DIR, "provider-comparison.json")
  writeFileSync(resultsPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    questions: questions.length,
    questionIds: questions.map((q) => q.id),
    embedder: embedder.model,
    paceMs,
    pricesAsOf: PRICES_AS_OF,
    summaries, skipped, raw: rawOutcomes,
  }, null, 2))
  console.log(`\nraw per-question outcomes written to ${resultsPath}`)
  console.log(`cleaned up ${Number(deleted?.numDeletedRows ?? 0)} harness conversations.`)
  await db.destroy()
}

main().catch(async (err) => {
  console.error("\ncomparison failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
//#endregion
