//#region Type Defs
/**
 * The structured answer contract — what the model must return instead of
 * free text. This is the project's thesis (plan §"the one design decision"):
 * an answer is a list of CLAIMS, each naming the retrieved chunk it came
 * from and quoting the verbatim span it relies on, so code can verify the
 * quote actually occurs there (verify.ts) and strip what doesn't check out
 * BEFORE the visitor sees it.
 *
 * One citation per claim, flat, by design: a claim needing two sources is
 * two claims. Multi-citation claims would make the strip decision ambiguous
 * (strip on ANY failure? on ALL?) — one quote per claim keeps "unverified →
 * stripped" a single deterministic rule. There is deliberately NO uncited
 * claim shape: prose the model cannot ground is prose the visitor never
 * sees, and connective filler ("Great question!") earns its keep nowhere in
 * a support answer.
 */
interface Claim {
  /** Visitor-facing sentence(s) — what the widget renders. */
  text: string
  /** Id of the retrieved chunk this claim is grounded in. */
  chunkId: string
  /** Verbatim span from that chunk. Verification is whitespace-normalized
   *  but case-sensitive and otherwise exact (verify.ts). */
  quote: string
}

interface AnswerPayload {
  claims: Claim[]
}

type ParseResult = { ok: true; payload: AnswerPayload } | { ok: false; errors: string[] }
//#endregion

//#region Constants
/** Hard cap on claims per answer. Real grounded answers run 2–8 claims; the
 *  cap exists so a looping model can't make the verifier and the citations
 *  table pay for 10,000 of them. Generous enough to never bite an honest
 *  answer — hitting it IS evidence of a broken generation. */
const MAX_CLAIMS = 32

/**
 * The JSON Schema handed to providers with native structured output
 * (LLMRequest.responseSchema). This is the same contract parseAnswerPayload
 * enforces, expressed for the provider side; the validator below remains the
 * source of truth because native enforcement ranges from real (Gemini) to
 * advisory (JSON mode), so nothing downstream trusts the provider's word.
 * additionalProperties: false everywhere — unknown keys are how prompt-
 * injected instructions would smuggle data past the shape check.
 */
const ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      maxItems: MAX_CLAIMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "chunkId", "quote"],
        properties: {
          text: { type: "string", minLength: 1 },
          chunkId: { type: "string", minLength: 1 },
          quote: { type: "string", minLength: 1 },
        },
      },
    },
  },
}
//#endregion

//#region Validation
/** True for strings with visible content — "  " fails. Blank text or quote
 *  would render as nothing / verify against nothing; both are model bugs
 *  the retry prompt should name, not shapes to pass along. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Validates a parsed JSON value against the answer contract. Hand-rolled
 * (no zod/ajv) because shared/ is dependency-free by construction (§2.4)
 * and the whole contract is one object with one array of three-string
 * objects — a schema library would be more code than the check.
 *
 * Collects EVERY error instead of failing fast: the pipeline gets exactly
 * one retry (anti-tutorial rules — validate-and-one-retry, then count it),
 * so the retry prompt must name everything wrong at once. Error strings are
 * path-prefixed ("claims[2].quote: …") because they are literally pasted
 * into that prompt — the model needs to find the field.
 */
function parseAnswerPayload(value: unknown): ParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['root: expected an object with a "claims" array'] }
  }
  const claims = (value as Record<string, unknown>)["claims"]
  if (!Array.isArray(claims)) {
    return { ok: false, errors: ["claims: expected an array"] }
  }
  if (claims.length > MAX_CLAIMS) {
    return {
      ok: false,
      errors: [`claims: at most ${MAX_CLAIMS} claims allowed, got ${claims.length}`],
    }
  }

  const errors: string[] = []
  const parsed: Claim[] = []
  claims.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`claims[${i}]: expected an object with text, chunkId, quote`)
      return
    }
    const claim = entry as Record<string, unknown>
    const { text, chunkId, quote } = claim
    if (!isNonBlankString(text)) errors.push(`claims[${i}].text: expected a non-blank string`)
    if (!isNonBlankString(chunkId)) errors.push(`claims[${i}].chunkId: expected a non-blank string`)
    if (!isNonBlankString(quote)) errors.push(`claims[${i}].quote: expected a non-blank string`)
    if (isNonBlankString(text) && isNonBlankString(chunkId) && isNonBlankString(quote)) {
      parsed.push({ text, chunkId, quote })
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, payload: { claims: parsed } }
}

/**
 * Parses raw model TEXT into an AnswerPayload — the entry point the pipeline
 * calls on the collected stream. Models wrap JSON in markdown fences and
 * preambles no matter how firmly told not to, and weaker structured-output
 * paths (JSON mode, Ollama) enforce nothing — so this tries, in order:
 *
 *   1. the text as-is,
 *   2. the inside of a ``` fence (with or without a language tag),
 *   3. the first "{" through the last "}" (preamble/postamble stripping).
 *
 * Escalating like this can't false-positive into a WRONG payload: every
 * candidate must still survive JSON.parse AND the structural validation
 * above — the fallbacks only rescue formatting noise, never shape errors.
 * All three failing returns the LAST parse error plus context; the caller
 * counts it as a schema violation (a published metric, not a swallowed
 * exception) and spends its one retry.
 */
function parseAnswerText(text: string): ParseResult {
  const candidates: string[] = [text.trim()]

  const fence = text.match(/```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)```/)
  const fenced = fence?.[1]
  if (fenced !== undefined) candidates.push(fenced.trim())

  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))

  let lastError = "empty response"
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      continue
    }
    // Valid JSON of the wrong SHAPE is a final verdict, not a formatting
    // problem — trying looser candidates would just re-parse the same
    // payload. Return the structural errors immediately.
    return parseAnswerPayload(parsed)
  }
  return { ok: false, errors: [`response is not valid JSON: ${lastError}`] }
}
//#endregion

//#region Exports
export { MAX_CLAIMS, ANSWER_JSON_SCHEMA, parseAnswerPayload, parseAnswerText }
export type { Claim, AnswerPayload, ParseResult }
//#endregion
