//#region Why this file
// The metrics read layer (M5.1) — the numbers the plan says to instrument
// from day one, finally aggregated. Nothing here needed a migration,
// because the columns were written when the pipeline was: messages carries
// refused/model/ttft_ms/total_ms (§3.3.2), message_citations carries every
// claim's verdict verified AND stripped (§3.3.2), and handoff_sessions
// carries requested_at (§3.3.4). Retrofitting metrics is how projects end
// up with none; this file is the payoff for not doing that.
//
// Straight from Postgres like every dashboard read, org-scoped in the
// WHERE, and aggregated IN SQL rather than in JS: percentile_cont over an
// indexed window is one pass in the database, where pulling a month of
// answers into a Node process to sort them would be several megabytes to
// compute six numbers.
//
// Every rate is `number | null`, never a silent zero. A tenant with no
// answers yet has no deflection rate — it is undefined, not 0%, and a
// dashboard that prints "0%" for "no data" is a dashboard that lies during
// exactly the week someone is deciding whether the product works.
//#endregion

//#region Imports
import { sql } from "kysely"

import { costUsd, PRICES_AS_OF } from "@shared/pricing/models"

import { db } from "@/lib/db"
//#endregion

//#region Types
interface AnswerMetrics {
  /** Assistant messages in the window — the denominator of most rates. */
  answers: number
  /** Answers the groundedness gate declined (§3.15.1). */
  refusals: number
  refusalRate: number | null
  /** Latency over ANSWERED messages only — refusals never call a model, so
   *  including them would compare a first-token time against a set of rows
   *  that has none. See the query for what that looked like. */
  ttftP50Ms: number | null
  ttftP95Ms: number | null
  totalP50Ms: number | null
  totalP95Ms: number | null
  /** Questions that produced NO answer because the model broke the JSON
   *  contract twice (M7.10). Counted from the org's daily counters rather
   *  than from messages, because in that case there IS no message — which
   *  is precisely why it has to be counted somewhere: a provider failing
   *  systematically would otherwise be invisible here, its worst outcome
   *  recorded as no outcome. Not part of `answers`, so it never dilutes a
   *  rate whose denominator is answers that exist. */
  schemaFailures: number
}

interface GroundingMetrics {
  /** Every claim the model made, verified and stripped alike. */
  claims: number
  stripped: number
  /** The project's headline honesty number: how much model output the
   *  verifier refused to show a visitor. */
  stripRate: number | null
  /** Split by failure mode, because they mean different things: a
   *  fabricated chunk id is a model inventing a source, a missing quote is
   *  a model misquoting a real one. */
  unknownChunk: number
  quoteNotFound: number
}

interface DeflectionMetrics {
  /** Conversations with at least one answer — a visitor who opened the
   *  bubble and said nothing is not a deflection either way. */
  conversations: number
  escalated: number
  deflectionRate: number | null
  /** Escalations that a person actually answered, and how fast. */
  handoffsAnswered: number
  firstHumanResponseP50Ms: number | null
  firstHumanResponseP95Ms: number | null
}

/**
 * One row of the provider-comparison table the plan wants — now with the
 * cost column that was blocked on a price list (shared/pricing/models.ts).
 *
 * There is deliberately no per-model refusal count. A gate refusal happens
 * BEFORE a model is chosen (§3.15.1 decides on retrieval distance alone),
 * so the pipeline writes model = NULL on those rows and a per-model refusal
 * column could only ever read zero. It shipped as one in M5.1 and passed
 * its test, because the test fixture set a model on a refused row where the
 * pipeline never does — the fixture now matches production, and the column
 * is gone. Refusals are counted once, at org level, where they are real.
 */
interface ModelMetrics {
  model: string
  answers: number
  /** Answers whose provider actually reported usage — the denominator of
   *  this row's cost, and usually but not always `answers`. */
  meteredAnswers: number
  inputTokens: number
  outputTokens: number
  /** List-price cost of this row's measured tokens, or null when the model
   *  is not in the price list (self-hosted, or newer than the table). */
  costUsd: number | null
  ttftP50Ms: number | null
  totalP50Ms: number | null
  /** Answers this model had to be asked TWICE for, because its first reply
   *  broke the JSON answer contract (M7.10). The plan's provider-comparison
   *  metric: four providers enforce a schema four different ways, and this
   *  is the column where that difference shows up as a number instead of an
   *  assumption. `answers` is the denominator — every row here ran a model,
   *  since the gate refuses before choosing one. */
  schemaViolations: number
}

/**
 * The plan's "measured cost per 1,000 answered questions", with the two
 * numbers that keep it honest beside it.
 *
 * Denominator is GENERATED answers — refusals are excluded, because a
 * refusal never calls a model and folding it in would make a bot that
 * refuses more look cheaper per answer rather than more cautious. The
 * refusal count sits next to it on the page for exactly that comparison.
 */
interface CostMetrics {
  /** Total list-price cost of every answer this layer could price. */
  costUsd: number | null
  /** Answers behind that figure: a priced model AND reported usage. */
  pricedAnswers: number
  /** Generated answers it could NOT price — an unlisted model, or a
   *  provider that reported no usage. Shown, not hidden: a cost figure
   *  covering half the traffic must say so. */
  unpricedAnswers: number
  costPer1kAnswersUsd: number | null
  /** When the price table was last checked (shared/pricing/models.ts). */
  pricesAsOf: string
}

export interface OrgMetrics {
  windowDays: number
  answers: AnswerMetrics
  grounding: GroundingMetrics
  deflection: DeflectionMetrics
  cost: CostMetrics
  byModel: ModelMetrics[]
}
//#endregion

//#region Helpers
/** A rate, or null when the denominator is zero. Deliberately not 0: see
 *  the header. */
function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/** Postgres returns bigint counts as strings (pg does not coerce, because
 *  a bigint does not always fit a JS number) and numerics likewise. Every
 *  aggregate goes through here so a count never reaches the UI as "12". */
function num(value: unknown): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function maybeNum(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
//#endregion

//#region Queries
/**
 * Everything the metrics page shows, for one org over a trailing window.
 *
 * Four queries rather than one heroic join: they have different grains
 * (messages, citations, conversations, handoffs), and a single query would
 * either fan out — counting the same answer once per citation — or need
 * subqueries that read worse than four honest statements. A tenant's month
 * is thousands of rows, not millions.
 */
export async function getOrgMetrics(orgId: string, windowDays = 30): Promise<OrgMetrics> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const [answers, grounding, deflection, byModel] = await Promise.all([
    answerMetrics(orgId, since),
    groundingMetrics(orgId, since),
    deflectionMetrics(orgId, since),
    modelMetrics(orgId, since),
  ])
  // Cost is DERIVED from the by-model rows rather than queried: prices are
  // per model, so any total is a sum over exactly those groups, and a fifth
  // query would have to re-group the same rows to produce the same numbers.
  return { windowDays, answers, grounding, deflection, cost: costMetrics(byModel), byModel }
}

async function answerMetrics(orgId: string, since: Date): Promise<AnswerMetrics> {
  // percentile_cont over ttft/total, computed in one pass on the
  // (org_id, created_at) index §3.3.2 put there for the daily cap — the
  // same index serves both, which is why the cap query and this one look
  // alike.
  //
  // The percentiles FILTER OUT refusals, and that is not a cosmetic choice.
  // A gate refusal costs zero tokens (§3.15.1 decides before any model
  // call), so it has a total_ms but no ttft_ms — and computing the two over
  // different row sets produced a live page where the full answer (99 ms)
  // looked FASTER than its own first token (110 ms). Same rows for both, or
  // the numbers are not comparable. What is lost is the refusal path's
  // latency, which is fast by construction and is what the refusal COUNT
  // beside it already reports.
  const row = await db
    .selectFrom("messages")
    .select([
      sql<string>`count(*)`.as("answers"),
      sql<string>`count(*) filter (where refused)`.as("refusals"),
      sql<
        number | null
      >`percentile_cont(0.5) within group (order by ttft_ms) filter (where not refused)`.as(
        "ttft_p50",
      ),
      sql<
        number | null
      >`percentile_cont(0.95) within group (order by ttft_ms) filter (where not refused)`.as(
        "ttft_p95",
      ),
      sql<
        number | null
      >`percentile_cont(0.5) within group (order by total_ms) filter (where not refused)`.as(
        "total_p50",
      ),
      sql<
        number | null
      >`percentile_cont(0.95) within group (order by total_ms) filter (where not refused)`.as(
        "total_p95",
      ),
    ])
    .where("org_id", "=", orgId)
    .where("role", "=", "assistant")
    .where("created_at", ">=", since)
    .executeTakeFirst()

  // The one number on this page that does NOT come from messages, because
  // the thing it counts is the absence of one: a question the model failed
  // to answer within the contract, twice. usage_daily is where the pipeline
  // records it (migration 010). Days are UTC and `since` is an instant, so
  // this rounds to whole days — coarser than the rest of the window by up to
  // one day, which is the right trade for a number read as "is this
  // happening at all?" rather than as a rate.
  const failures = await db
    .selectFrom("usage_daily")
    .select(sql<string>`coalesce(sum(schema_failures), 0)`.as("schema_failures"))
    .where("org_id", "=", orgId)
    .where("day", ">=", since.toISOString().slice(0, 10))
    .executeTakeFirst()

  const total = num(row?.answers)
  const refusals = num(row?.refusals)
  return {
    answers: total,
    schemaFailures: num(failures?.schema_failures),
    refusals,
    refusalRate: rate(refusals, total),
    ttftP50Ms: maybeNum(row?.ttft_p50),
    ttftP95Ms: maybeNum(row?.ttft_p95),
    totalP50Ms: maybeNum(row?.total_p50),
    totalP95Ms: maybeNum(row?.total_p95),
  }
}

async function groundingMetrics(orgId: string, since: Date): Promise<GroundingMetrics> {
  // Citations carry no org_id (they hang off messages, §3.3.2), so the
  // tenant boundary comes through the join — which is also what scopes the
  // window, since a citation's age is its message's age.
  const row = await db
    .selectFrom("message_citations")
    .innerJoin("messages", "messages.id", "message_citations.message_id")
    .select([
      sql<string>`count(*)`.as("claims"),
      sql<string>`count(*) filter (where message_citations.verdict <> 'verified')`.as("stripped"),
      sql<string>`count(*) filter (where message_citations.verdict = 'unknown_chunk')`.as(
        "unknown_chunk",
      ),
      sql<string>`count(*) filter (where message_citations.verdict = 'quote_not_found')`.as(
        "quote_not_found",
      ),
    ])
    .where("messages.org_id", "=", orgId)
    .where("messages.created_at", ">=", since)
    .executeTakeFirst()

  const claims = num(row?.claims)
  const stripped = num(row?.stripped)
  return {
    claims,
    stripped,
    stripRate: rate(stripped, claims),
    unknownChunk: num(row?.unknown_chunk),
    quoteNotFound: num(row?.quote_not_found),
  }
}

async function deflectionMetrics(orgId: string, since: Date): Promise<DeflectionMetrics> {
  // Deflection is counted per CONVERSATION, not per message. Per message
  // would flatter the product: a long thread that ends in an escalation
  // would still contribute a dozen "deflected" answers. The denominator is
  // conversations the bot actually answered in — a visitor who opened the
  // bubble and typed nothing is neither deflected nor escalated.
  const row = await db
    .selectFrom("conversations")
    .select([
      sql<string>`count(*)`.as("conversations"),
      sql<string>`count(*) filter (where exists (
        select 1 from handoff_sessions h where h.conversation_id = conversations.id
      ))`.as("escalated"),
    ])
    .where("org_id", "=", orgId)
    .where("created_at", ">=", since)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("messages")
          .select("messages.id")
          .whereRef("messages.conversation_id", "=", "conversations.id")
          .where("messages.role", "=", "assistant"),
      ),
    )
    .executeTakeFirst()

  // Time-to-first-human-response, the plan's product metric. Measured to
  // the first agent MESSAGE, not to claimed_at: attaching is what claims a
  // handoff (§3.25), and a queue where agents open conversations promptly
  // and answer slowly would look perfect measured the easy way.
  const response = await db
    .selectFrom("handoff_sessions")
    .innerJoin("messages", (join) =>
      join
        .onRef("messages.conversation_id", "=", "handoff_sessions.conversation_id")
        .on("messages.role", "=", "agent"),
    )
    .select([
      sql<string>`count(distinct handoff_sessions.id)`.as("answered"),
      sql<number | null>`percentile_cont(0.5) within group (
        order by extract(epoch from (messages.created_at - handoff_sessions.requested_at)) * 1000
      )`.as("p50"),
      sql<number | null>`percentile_cont(0.95) within group (
        order by extract(epoch from (messages.created_at - handoff_sessions.requested_at)) * 1000
      )`.as("p95"),
    ])
    .where("handoff_sessions.org_id", "=", orgId)
    .where("handoff_sessions.requested_at", ">=", since)
    // Only the FIRST agent turn per handoff: later replies are the same
    // person still talking, and averaging them in would measure
    // conversation length rather than response time.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("messages as earlier")
            .select("earlier.id")
            .whereRef("earlier.conversation_id", "=", "handoff_sessions.conversation_id")
            .where("earlier.role", "=", "agent")
            .whereRef("earlier.created_at", "<", "messages.created_at")
            .whereRef("earlier.created_at", ">=", "handoff_sessions.requested_at"),
        ),
      ),
    )
    .whereRef("messages.created_at", ">=", "handoff_sessions.requested_at")
    .executeTakeFirst()

  const conversations = num(row?.conversations)
  const escalated = num(row?.escalated)
  return {
    conversations,
    escalated,
    deflectionRate: rate(conversations - escalated, conversations),
    handoffsAnswered: num(response?.answered),
    firstHumanResponseP50Ms: maybeNum(response?.p50),
    firstHumanResponseP95Ms: maybeNum(response?.p95),
  }
}

async function modelMetrics(orgId: string, since: Date): Promise<ModelMetrics[]> {
  // The provider-comparison table: same corpus, same questions, different
  // models — latency and now token volume side by side. Only rows with a
  // model, which excludes refusals by construction (the gate refuses before
  // choosing one, so those rows carry model = NULL).
  const rows = await db
    .selectFrom("messages")
    .select([
      "model",
      sql<string>`count(*)`.as("answers"),
      sql<string>`count(*) filter (where input_tokens is not null)`.as("metered"),
      // coalesce so an entirely unmetered model reports 0 tokens rather
      // than null — "no tokens measured" is carried by `metered`, and two
      // different nulls meaning two different things is how a cost figure
      // becomes unreadable.
      sql<string>`coalesce(sum(input_tokens), 0)`.as("input_tokens"),
      sql<string>`coalesce(sum(output_tokens), 0)`.as("output_tokens"),
      sql<number | null>`percentile_cont(0.5) within group (order by ttft_ms)`.as("ttft_p50"),
      sql<number | null>`percentile_cont(0.5) within group (order by total_ms)`.as("total_p50"),
      // SUM, not count-where-positive: the cap is one retry today, so the
      // two agree, but summing is what stays correct if it ever is not.
      // coalesce for rows written before migration 010, whose count is NULL.
      sql<string>`coalesce(sum(schema_violations), 0)`.as("schema_violations"),
    ])
    .where("org_id", "=", orgId)
    .where("role", "=", "assistant")
    .where("model", "is not", null)
    .where("created_at", ">=", since)
    .groupBy("model")
    .orderBy(sql`count(*)`, "desc")
    .execute()

  return rows.map((row) => {
    const model = row.model ?? "unknown"
    const inputTokens = num(row.input_tokens)
    const outputTokens = num(row.output_tokens)
    return {
      model,
      answers: num(row.answers),
      meteredAnswers: num(row.metered),
      inputTokens,
      outputTokens,
      costUsd: costUsd(model, inputTokens, outputTokens),
      ttftP50Ms: maybeNum(row.ttft_p50),
      totalP50Ms: maybeNum(row.total_p50),
      schemaViolations: num(row.schema_violations),
    }
  })
}

/** Folds the per-model rows into one cost figure, keeping track of what it
 *  could not account for. Pure — no query — so the arithmetic is unit
 *  testable without a database. */
function costMetrics(byModel: readonly ModelMetrics[]): CostMetrics {
  let total = 0
  let priced = 0
  let unpriced = 0
  for (const row of byModel) {
    // A row contributes only when BOTH hold: we know the model's price and
    // the provider told us what it used. Everything else lands in
    // `unpriced`, where the page can show it — a cost that silently covered
    // 40% of the traffic would be worse than no cost at all.
    if (row.costUsd !== null) {
      total += row.costUsd
      priced += row.meteredAnswers
      unpriced += row.answers - row.meteredAnswers
    } else {
      unpriced += row.answers
    }
  }
  return {
    costUsd: priced > 0 ? total : null,
    pricedAnswers: priced,
    unpricedAnswers: unpriced,
    costPer1kAnswersUsd: priced > 0 ? (total / priced) * 1000 : null,
    pricesAsOf: PRICES_AS_OF,
  }
}
//#endregion
