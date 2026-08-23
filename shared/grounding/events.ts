//#region Type Defs
/**
 * The answer-stream wire protocol — what the widget receives, one event per
 * SSE message, as the pipeline produces them. Defined in shared/ because it
 * is the contract BETWEEN realtime (producer) and the widget (consumer),
 * and defined claim-granular on purpose: a claim is the smallest unit that
 * can be VERIFIED, so it is the smallest unit that may reach a visitor —
 * raw model deltas can never be forwarded, because stripping happens
 * before display, not after. Today the pipeline verifies after collecting
 * the full response; an incremental claim parser can later emit each claim
 * the moment it verifies WITHOUT changing this protocol, which is exactly
 * why the protocol is claim-granular rather than delta-granular.
 */
type AnswerEvent =
  /** First event, always: the ids the widget needs to continue the thread. */
  | { type: "meta"; conversationId: string; messageId: string }
  /** One VERIFIED claim, in display order. url/headingPath let the widget
   *  render the citation without another round-trip. Stripped claims never
   *  appear here — they exist only in message_citations. */
  | { type: "claim"; ord: number; text: string; url: string | null; headingPath: string | null }
  /** The groundedness gate declined to answer (or nothing survived
   *  verification). The widget renders the fallback text and offers
   *  escalation (M4). */
  | { type: "refusal"; text: string }
  /** A human owns this conversation, so the bot did not answer (M4.1). The
   *  visitor's message was still PERSISTED — it is what the agent needs to
   *  read — and it arrives instead of claims, never alongside them: two
   *  voices answering one question is the failure mode handoff exists to
   *  prevent. `pending` is "waiting for someone", `active` is "someone is
   *  here"; the widget words the wait differently for each. */
  | { type: "handoff"; status: "pending" | "active" }
  /** A transient failure AFTER the stream opened (model failed the JSON
   *  contract twice, provider outage mid-answer). Distinct from refusal —
   *  a refusal is an answer, an error is the absence of one; the widget
   *  offers "try again" here and never does for refusals. Carries no
   *  detail: failure specifics on a public stream are reconnaissance. */
  | { type: "error" }
  /** Terminal event: verification stats for observability. claimsTotal
   *  counts what the model EMITTED; claimsShown what survived. */
  | { type: "done"; claimsTotal: number; claimsShown: number }
//#endregion

//#region Exports
export type { AnswerEvent }
//#endregion
