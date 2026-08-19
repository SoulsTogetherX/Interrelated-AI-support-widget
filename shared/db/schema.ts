//#region Imports
// kysely is a TYPE-ONLY import, erased at compile time — shared/ stays
// dependency-free at runtime. Each consumer resolves the types from its own
// node_modules (realtime and web both declare kysely); the root package
// carries it as a devDependency purely so `typecheck:shared` can see it,
// the same arrangement fastembed has for providers/local.ts.
import type { ColumnType, Generated } from "kysely"

// The plan catalog owns the tier ids (shared/billing/plans.ts). Importing
// the type here rather than repeating the union means a plan the catalog
// does not know is a compile error at every query that writes one. It does
// NOT prove the database's CHECK agrees — the compiler cannot read SQL — so
// a DB-gated test inserts an org at every catalog id, and the two
// mechanisms cover what the other cannot.
import type { PlanId } from "../billing/plans"
//#endregion

//#region Type Defs
// Hand-written schema types, kept in lockstep with the raw-SQL migrations by
// review rather than by codegen. kysely-codegen was considered and rejected
// while the schema is young: regenerating on every migration churns diffs,
// and the generator's output can't carry the WHY comments these types do.
// The deal: any migration that touches a table updates this file in the same
// change, or the change doesn't merge.
//
// MOVED from realtime/src/db/ in M3.2: once the dashboard (web/) queries the
// same database, the table types are a cross-package contract exactly like
// the wire protocol — and shared/ is where cross-package contracts live.
// realtime still OWNS the schema (its migrations are the only thing that
// changes the database; web never migrates); realtime/src/db/schema.ts
// re-exports this file so its internal imports read unchanged.
//
// Timestamp columns use ColumnType<Date, string | Date, string | Date>:
// pg returns Date on select, but inserts/updates may pass ISO strings
// (e.g. from JSON payloads) without a lying cast.

/** A dashboard tenant. Everything in the system hangs off an organization. */
interface OrganizationsTable {
  id: string
  name: string
  /** Billing tier. Enforced by CHECK in the migration; typed from the plan
   *  catalog so a typo like "prem" is a compile error, not a runtime
   *  constraint violation — and so the caps the catalog states are the caps
   *  this column can hold. */
  plan: Generated<PlanId>
  /** Optional tone/persona text prepended to the org's answer prompts. Lives
   *  on the org (not per-source) because it is part of the CACHEABLE prompt
   *  prefix — see the prompt-assembly notes in CLAUDE.md when M2 lands. */
  system_persona: string | null
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** A dashboard login. Email is encrypted at rest (AES-GCM) with a separate
 *  deterministic blind index for lookups — the same at-rest scheme as the
 *  provider keys, so one leaked backup discloses neither. Auth code arrives
 *  in M3; the columns exist from §3.3 because retrofitting
 *  encryption onto plaintext emails means a data migration under load. */
interface UsersTable {
  id: string
  /** HMAC of the normalized email under a server-held key. UNIQUE. Lookups
   *  compute the HMAC and match this column; the ciphertext is never scanned. */
  email_index: string
  /** AES-256-GCM ciphertext of the email, nonce prepended, base64. */
  email_ciphertext: string
  /** scrypt hash in the Node crypto format (N=2^15,r=8,p=1 baked into the
   *  stored string so parameters can be raised without a rehash migration). */
  password_hash: string
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Membership joins users to organizations. Exactly one owner per org,
 *  enforced by a partial unique index in the migration. */
interface OrgMembersTable {
  org_id: string
  user_id: string
  role: "owner" | "agent"
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Dashboard sessions. The id IS the sha256 of the cookie token — the raw
 *  token exists only in the user's cookie, so a database leak alone cannot
 *  be replayed as a login. */
interface SessionsTable {
  id: string
  user_id: string
  expires_at: ColumnType<Date, string | Date, string | Date>
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Widget credentials. Two kinds:
 *  - "public": the pk_… value pasted into the customer's <script> tag.
 *    Identifies the org; deliberately not a secret (see the trust-model
 *    section of CLAUDE.md).
 *  - "secret": the sk_… value a customer's backend presents to
 *    POST /v1/sessions (trust-model layer 6, M7.3). Only its sha256 is
 *    stored, same reasoning as sessions.id; the dashboard shows the value
 *    once at issue and keeps a four-character suffix for display.
 *  Revocation is a timestamp, not a delete, so rotation keeps an audit trail
 *  and old keys can serve through a grace window — for both kinds alike:
 *  the session routes accept a key while revoked_at IS NULL OR revoked_at >
 *  NOW(), on Postgres's clock (M7.1). */
interface ApiKeysTable {
  id: string
  org_id: string
  kind: "public" | "secret"
  /** The literal pk_… value. NULL for secret keys. Uniqueness among live
   *  keys is a partial index (WHERE revoked_at IS NULL) so a rotated-out
   *  value could in principle be reissued later without a conflict. */
  public_id: string | null
  /** sha256 hex of the sk_… value (shared/utils/ids.ts hashSecretKey). NULL
   *  for public keys. UNIQUE across every row since 007 — a rotated-out
   *  secret must never be reissued, unlike a public id. */
  secret_hash: string | null
  /** The sk_… value's last four characters — the only plaintext fragment
   *  kept (secretKeySuffix). Paired with the kind by a CHECK: present iff
   *  kind = 'secret'. Since 007. */
  secret_suffix: string | null
  last_used_at: ColumnType<Date | null, never, string | Date>
  revoked_at: ColumnType<Date | null, never, string | Date>
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** A tenant's BYO provider configuration, one row per (org, role). The API
 *  key is AES-256-GCM ciphertext under realtime's server-held master key
 *  (AAD = row id); key_suffix is the ONLY plaintext fragment that exists
 *  outside it. Replacement hard-deletes the old row — retaining superseded
 *  ciphertexts of someone else's credential is liability, not audit trail
 *  (see §3.3.3 for the full argument + the shape CHECKs). */
interface OrgProviderCredentialsTable {
  id: string
  org_id: string
  role: "generation" | "embedding"
  provider: "groq" | "gemini" | "ollama" | "openai_compatible" | "anthropic"
  /** NULL = the provider's default model; validate.ts requires an explicit
   *  model where no sane default exists (openai_compatible, ollama). */
  model: string | null
  base_url: string | null
  /** The embedding model's true dimension, discovered by the Test
   *  round-trip (§3.3.3). Present exactly on embedding rows
   *  (CHECK-enforced) — a generation model has no dimension. */
  dim: number | null
  key_ciphertext: string | null
  key_suffix: string | null
  last_validated_at: ColumnType<Date | null, string | Date | null, string | Date>
  last_validation: string | null
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Origin allowlist: the set of exact origins allowed to mint widget
 *  sessions for an org. Exact match only — wildcard matching is a common
 *  source of allowlist bypasses (e.g. a suffix check that admits
 *  evil-example.com for example.com), so it is unrepresentable here. */
interface AllowedOriginsTable {
  org_id: string
  /** Scheme + host + optional port, e.g. "https://docs.example.com". */
  origin: string
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** A crawl target or upload an org has connected. status tracks the ingest
 *  lifecycle at source granularity; per-run detail lives in ingest_jobs. */
interface SourcesTable {
  id: string
  org_id: string
  kind: "url" | "sitemap" | "upload"
  /** URL for url/sitemap kinds; original filename for uploads. */
  location: string
  crawl_depth: Generated<number>
  status: Generated<"pending" | "crawling" | "ready" | "failed">
  last_crawled_at: ColumnType<Date | null, never, string | Date>
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** One block of an uploaded document, as STORED (migration 009): a span,
 *  never the text. The parser contract is
 *  `block.text === text.slice(charStart, charEnd)`, so keeping the text here
 *  too would double the row to record what the offsets already determine —
 *  and would create the one way the two copies could disagree. The worker
 *  slices them back out, so the contract holds on the way out as on the way
 *  in. `level` rides along only for headings, as in the chunker's Block. */
interface UploadBlockSpan {
  kind: "heading" | "paragraph" | "code"
  level?: number
  charStart: number
  charEnd: number
}

/** What an uploaded file left behind (migration 009) — one row per upload
 *  source, holding the parser's extraction rather than the file. The bytes
 *  are parsed in the upload request and dropped; this text is what the
 *  worker chunks and embeds, and — the reason it is kept at all — the only
 *  thing an embedding-model change can re-embed, since an upload has
 *  nothing to re-fetch. */
interface SourceUploadsTable {
  source_id: string
  /** The name the customer's file had; copied to documents.url so a
   *  citation from an upload can say where it came from. */
  filename: string
  /** Which parser read it, DETECTED from the bytes rather than declared. */
  format: "pdf" | "html" | "markdown"
  /** The original file's size — the one fact about the bytes that outlives
   *  them, so the dashboard can say "2.1 MB PDF" about a file it no longer
   *  has. */
  byte_size: number
  title: string | null
  text: string
  /** Written as a JSON string (pg would serialize a JS array as a Postgres
   *  array literal), read back parsed — ingest_jobs.skipped_pages exactly. */
  blocks: ColumnType<UploadBlockSpan[], string, string>
  uploaded_at: ColumnType<Date, string | Date | undefined, never>
}

/** One fetched page or uploaded file. content_hash (sha256 of normalized
 *  text) is the recrawl short-circuit: identical hash → skip re-chunk and
 *  re-embed, which is what keeps recrawls nearly free on embedding quota.
 *  Soft-deleted via deleted_at; URL uniqueness applies among live rows. */
interface DocumentsTable {
  id: string
  org_id: string
  source_id: string
  url: string
  title: string | null
  content_hash: string
  token_count: number | null
  /** Updatable on purpose: a recrawl refreshes fetched_at whether or not the
   *  content changed — it answers "how stale is this page?" in the dashboard. */
  fetched_at: ColumnType<Date, string | Date | undefined, string | Date>
  deleted_at: ColumnType<Date | null, never, string | Date>
}

/** The retrieval unit. heading_path travels with the chunk so citations can
 *  show where in the document a claim came from; char_start/char_end span
 *  back into the source for deep-linking. tsv is Postgres-generated (the
 *  lexical half of hybrid retrieval) — never written by application code. */
interface ChunksTable {
  id: string
  org_id: string
  document_id: string
  /** Position within the document, 0-based; unique per document. */
  ord: number
  heading_path: string | null
  text: string
  token_count: number
  char_start: number | null
  char_end: number | null
  /** GENERATED ALWAYS — selectable for debugging, unwritable by design. */
  tsv: ColumnType<string, never, never>
}

/** One embedding of one chunk under one model. org_id is denormalized here
 *  (see §3.3.1) so the tenant filter lives on the same relation as
 *  the partial HNSW indexes. The pg driver represents vectors as strings
 *  ("[0.1,0.2,…]"); typed as string on all three arms — parsing to number[]
 *  happens in provider code, not in the driver types. */
interface ChunkEmbeddingsTable {
  chunk_id: string
  org_id: string
  /** Embedding model identifier, e.g. "bge-small-en-v1.5". Part of the PK:
   *  one chunk may carry embeddings under several models simultaneously
   *  (BYO-provider means different orgs genuinely use different models). */
  model: string
  /** The model's TRUE dimension before zero-padding to 1024. */
  dim: number
  embedding: string
}

/** One page a crawl did not ingest, and why — an entry of
 *  ingest_jobs.skipped_pages (migration 008). `reason` is a sentence the
 *  crawler wrote for the tenant: "disallowed by robots.txt (User-agent: *,
 *  Disallow: /private/)", "HTTP 404", "redirected off-origin to …". */
interface SkippedPage {
  url: string
  reason: string
}

/** How many skipped pages one job row keeps in `skipped_pages`. Mirrors the
 *  literal in migration 008's CHECK the way PADDED_DIM mirrors halfvec(1024):
 *  the worker stops recording at this many while `skipped_count` keeps
 *  counting, so "and N more" is arithmetic. A migration is frozen once
 *  applied, so this constant follows the schema rather than the reverse. */
const MAX_RECORDED_SKIPPED_PAGES = 50

/** Ingest queue row, consumed with FOR UPDATE SKIP LOCKED. The
 *  (state='running') = (locked_by IS NOT NULL) CHECK makes an unowned
 *  running job — the silent way work gets lost — unrepresentable. */
interface IngestJobsTable {
  id: string
  org_id: string
  source_id: string
  state: Generated<"queued" | "running" | "done" | "failed">
  attempts: Generated<number>
  locked_by: string | null
  /** Set by the claim and RENEWED per page (M7.5): the stale-lease reclaim
   *  measures from here, so a slow-but-healthy crawl is not mistaken for a
   *  crashed one. */
  locked_at: ColumnType<Date | null, string | Date | null, string | Date | null>
  docs_total: number | null
  docs_done: number | null
  error: string | null
  /** The TRUE number of pages skipped this crawl (008) — robots.txt, dead
   *  links, off-origin redirects, unparseable bodies. */
  skipped_count: Generated<number>
  /** The first MAX_RECORDED_SKIPPED_PAGES of them. Written as a JSON string
   *  (pg would serialize a JS array as a Postgres array literal), read back
   *  parsed — jsonb comes off the wire as a value. */
  skipped_pages: ColumnType<SkippedPage[], string | undefined, string>
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** One widget chat thread. visitor_id is the widget-generated anonymous id
 *  (no FK — visitors are not users). status carries 'escalated' from day
 *  one even though handoff is M4: the M2 widget must already render the
 *  state, and adding an enum value later is a migration. */
interface ConversationsTable {
  id: string
  org_id: string
  visitor_id: string
  status: Generated<"open" | "escalated" | "closed">
  created_at: ColumnType<Date, string | Date | undefined, never>
  /** Updated by the pipeline on every message — the dashboard's
   *  conversation list orders by exactly this column. */
  last_message_at: ColumnType<Date, string | Date | undefined, string | Date>
}

/** One message in a conversation. content is what the visitor actually SAW
 *  — for assistant messages, the verified-claims text after stripping (or
 *  the refusal fallback), never raw model output; the claim-level story
 *  lives in message_citations. org_id is denormalized (like
 *  chunk_embeddings) so the M5 pre-flight usage count needs no join.
 *  CHECKs in §3.3.2 pin model/refused/score/latency to the
 *  assistant role — mismatches are unrepresentable, not just untyped. */
interface MessagesTable {
  id: string
  conversation_id: string
  org_id: string
  role: "visitor" | "assistant" | "agent"
  content: string
  /** LLM that generated an assistant message — the provider-comparison
   *  table's key. NULL for visitor/agent rows (enforced by CHECK). */
  model: string | null
  /** True when the groundedness gate refused to answer (fused retrieval
   *  score below threshold). Deflection and correct-refusal metrics. */
  refused: Generated<boolean>
  /** The groundedness-gate signal for this answer — min dense cosine
   *  distance across the retrieved set (see answer/gate.ts for why NOT the
   *  fused RRF score: RRF is rank-based and relevance-blind). Kept
   *  per-answer so threshold tuning has production data, not just the eval
   *  set. */
  retrieval_score: number | null
  /** Time-to-first-token and total latency, ms — the headline metrics,
   *  instrumented from day one because retrofitting is how projects end
   *  up with none. */
  ttft_ms: number | null
  total_ms: number | null
  /** The provider's reported token usage for this answer (LLMUsage, whose
   *  field names these mirror), SUMMED across the retry when the model
   *  failed the contract once — a retried answer really did cost twice.
   *  NULL means "not reported": a gate refusal ran no model, and some
   *  OpenAI-compatible servers omit usage on streams. Never 0 for those,
   *  which is why the cost metric reports unpriced answers separately
   *  instead of averaging them in as free. Paired by CHECK — half a usage
   *  record is a parsing bug, not a partial measurement. */
  input_tokens: number | null
  output_tokens: number | null
  /** How many times the model broke the answer contract while producing
   *  this message (migration 010): 0 when it held on the first attempt, 1
   *  when the one retry rescued it. NULL means NO MODEL RAN — a gate
   *  refusal, a visitor's turn, an agent's reply — which is the token
   *  columns' distinction applied here: 0 would claim a model ran and held
   *  the contract, padding the violation rate's denominator with answers
   *  nobody generated. Paired with `model` by CHECK. The case this column
   *  cannot hold is the double failure, which writes no row at all; that
   *  one is counted on usage_daily.schema_failures. */
  schema_violations: number | null
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** One claim's citation verdict. EVERY claim is stored, verified and
 *  stripped alike — the strip rate is a published metric. chunk_id has
 *  deliberately NO FK: chunks are mutable pipeline state (re-chunks delete
 *  them) while transcripts are immutable history, so url/heading_path/
 *  quote are snapshots taken at answer time. Composite key like
 *  chunk_embeddings — nothing references a citation row individually. */
interface MessageCitationsTable {
  message_id: string
  /** Claim order within the message, 0-based. */
  ord: number
  chunk_id: string
  claim_text: string
  quote: string
  verdict: "verified" | "unknown_chunk" | "quote_not_found"
  /** Offsets into the cited chunk's text AS IT WAS at answer time; present
   *  exactly when verdict = 'verified' (CHECK-enforced equality). */
  span_start: number | null
  span_end: number | null
  url: string | null
  heading_path: string | null
}

/** One escalation of a conversation from the bot to a person (§3.3.4).
 *  Its own table rather than a column on conversations because an
 *  escalation has a lifecycle, two actors, and the timestamps M5's
 *  time-to-first-human-response metric measures between — and because a
 *  conversation can be escalated more than once over its life, which a
 *  column would overwrite. At most one OPEN row per conversation, enforced
 *  by a partial unique index, which is what makes escalation idempotent by
 *  construction rather than by a racing check-then-insert. */
interface HandoffSessionsTable {
  id: string
  org_id: string
  conversation_id: string
  status: Generated<"pending" | "active" | "closed">
  /** Why a human is involved: the visitor asked, or the bot could not
   *  answer. M5's deflection rate is the ratio between them. */
  reason: "visitor_request" | "low_confidence"
  /** The agent holding it. NULL until claimed, and back to NULL if that
   *  user is deleted — history outlives employment, which is why
   *  claimed_at (WHEN, permanent) rather than claimed_by (WHO, deletable)
   *  is what the 'active' CHECK depends on. */
  claimed_by: string | null
  requested_at: ColumnType<Date, string | Date | undefined, never>
  claimed_at: ColumnType<Date | null, string | Date | null, string | Date | null>
  closed_at: ColumnType<Date | null, string | Date | null, string | Date | null>
}

/** One org's counters for one UTC day (§3.3.6) — what the pre-flight quota
 *  check reads on the hot path and what a billing period sums. Written in
 *  the same transaction as the rows it counts, so it cannot drift from the
 *  history it summarizes; a nightly rollup would leave a cap enforced
 *  against a number up to a day stale, which is not a cap.
 *
 *  `day` is a DATE in UTC — pg returns it as a string in this driver's
 *  default, which is why the select type is string: a Date would carry a
 *  local-midnight time nobody meant. Counter columns are insert-or-add
 *  targets, never set directly outside the increment helper. */
interface UsageDailyTable {
  org_id: string
  day: ColumnType<string, string, never>
  /** Every assistant message, refusals included — see the migration for
   *  why the cheapest questions still count against a quota. */
  answers: Generated<number>
  refusals: Generated<number>
  /** Genuinely-created handoffs only; an idempotent re-request adds
   *  nothing (§3.23). */
  escalations: Generated<number>
  /** Questions that produced NO answer because the model broke the answer
   *  contract twice (migration 010). It lives here rather than on messages
   *  because there is no message row in that case — which is exactly why
   *  counting violations only per answer would make a systematically
   *  failing provider look perfect. */
  schema_failures: Generated<number>
  /** BIGINT in the database: pg returns it as a string, because a bigint
   *  does not always fit a JS number. Callers coerce at the edge. */
  input_tokens: ColumnType<string, string | number | undefined, string | number>
  output_tokens: ColumnType<string, string | number | undefined, string | number>
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>
}

/** One org's widget-session counters for one UTC day per ORIGIN (§3.3.8,
 *  trust-model layer 4): sessions minted for an allowlisted origin, and
 *  mints REFUSED from an unlisted one — the number that makes a copied
 *  snippet visible rather than inferred from a bill. `origin` is either a
 *  scheme://host[:port] string or one of realtime/src/usage/origins.ts's
 *  sentinels for refused values that were malformed or past the per-day
 *  distinct-origin cap; never a visitor identity, never a Referer path.
 *  Same day and counter conventions as usage_daily. */
interface OriginDailyTable {
  org_id: string
  day: ColumnType<string, string, never>
  origin: string
  minted: Generated<number>
  refused: Generated<number>
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>
}

/** What Stripe knows about an org's subscription (§3.3.7). Deliberately
 *  NOT the entitlement: `organizations.plan` is what the product allows and
 *  is read on the hot path before every model call, while this row is the
 *  billing record. The webhook moves the first when the second changes;
 *  between those moments they are independent, so a Stripe outage cannot
 *  stop a tenant's widget from answering.
 *
 *  `status` carries STRIPE's vocabulary rather than a translation of it —
 *  a support conversation held with their dashboard open is easier when the
 *  words match on both screens. org_id is the primary key: one subscription
 *  per organization, and nothing references the row individually. */
interface SubscriptionsTable {
  org_id: string
  stripe_customer_id: string
  stripe_subscription_id: string
  plan: PlanId
  status:
    | "trialing" | "active" | "past_due" | "canceled"
    | "incomplete" | "incomplete_expired" | "unpaid" | "paused"
  cancel_at_period_end: Generated<boolean>
  /** Null while a subscription is incomplete — it has no period yet. */
  current_period_end: ColumnType<Date | null, string | Date | null, string | Date | null>
  created_at: ColumnType<Date, string | Date | undefined, never>
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>
}

/** Every Stripe event this system has applied, keyed by STRIPE's event id.
 *  The primary key IS the idempotency mechanism: the handler inserts first
 *  and treats a conflict as "already applied", so a redelivered webhook
 *  cannot double-apply. A check-then-act read would race itself under
 *  exactly the retry storm it exists to survive. */
interface StripeEventsTable {
  id: string
  type: string
  received_at: ColumnType<Date, string | Date | undefined, never>
}

/** The Kysely database contract. Every query in the codebase is typed
 *  against this interface — a column typo is a compile error. */
interface Database {
  organizations: OrganizationsTable
  users: UsersTable
  org_members: OrgMembersTable
  sessions: SessionsTable
  api_keys: ApiKeysTable
  org_provider_credentials: OrgProviderCredentialsTable
  allowed_origins: AllowedOriginsTable
  sources: SourcesTable
  source_uploads: SourceUploadsTable
  documents: DocumentsTable
  chunks: ChunksTable
  chunk_embeddings: ChunkEmbeddingsTable
  ingest_jobs: IngestJobsTable
  conversations: ConversationsTable
  messages: MessagesTable
  message_citations: MessageCitationsTable
  handoff_sessions: HandoffSessionsTable
  usage_daily: UsageDailyTable
  origin_daily: OriginDailyTable
  subscriptions: SubscriptionsTable
  stripe_events: StripeEventsTable
}
//#endregion

//#region Exports
export type {
  Database,
  OrganizationsTable,
  UsersTable,
  OrgMembersTable,
  SessionsTable,
  ApiKeysTable,
  OrgProviderCredentialsTable,
  AllowedOriginsTable,
  SourcesTable,
  SourceUploadsTable,
  UploadBlockSpan,
  DocumentsTable,
  ChunksTable,
  ChunkEmbeddingsTable,
  IngestJobsTable,
  SkippedPage,
  ConversationsTable,
  MessagesTable,
  MessageCitationsTable,
  HandoffSessionsTable,
  UsageDailyTable,
  OriginDailyTable,
  SubscriptionsTable,
  StripeEventsTable,
}
export { MAX_RECORDED_SKIPPED_PAGES }
//#endregion
