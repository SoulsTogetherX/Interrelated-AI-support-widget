//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 005 — billing (M5.4): the subscription record, and the ledger
// of Stripe events that makes applying it idempotent.
//
// The load-bearing separation, and the reason `organizations.plan` is NOT
// replaced by a join: **entitlement and billing record are different
// things.** `organizations.plan` is what the product ALLOWS, read on the
// hot path before every model call (§3.18) — one column, no join, no
// dependency on a third party. `subscriptions` is what STRIPE knows: their
// customer and subscription ids, the status, when the period ends. The
// webhook moves the first when the second changes, and in between they are
// independent: Stripe being down cannot stop a tenant's widget from
// answering, and reading a quota never requires knowing anything about
// payments. Collapsing the two would put a billing outage on the answer
// path, which is the one place it must never be.
//
// Both tables are written ONLY by the dashboard's webhook handler
// (web/src/app/api/stripe/webhook/route.ts). realtime owns the schema — it
// owns every migration — but has no billing code at all: it reads the
// entitlement column and nothing else.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE subscriptions (
      -- org_id IS the primary key: this product allows one subscription per
      -- organization, and nothing references a subscription row
      -- individually, so (org) is its identity — the same natural-key
      -- argument as chunk_embeddings and message_citations. Stripe would
      -- happily hold several; representing that would be modelling a
      -- business we do not have.
      org_id                 TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      stripe_customer_id     TEXT NOT NULL CHECK (char_length(stripe_customer_id) BETWEEN 1 AND 255),
      -- UNIQUE so one Stripe subscription cannot be recorded against two
      -- orgs — a copied checkout link or a replayed webhook would be the
      -- way that happens, and it should fail loudly rather than quietly
      -- entitle a second tenant.
      stripe_subscription_id TEXT NOT NULL UNIQUE CHECK (char_length(stripe_subscription_id) BETWEEN 1 AND 255),
      -- Mirrors organizations.plan's CHECK (shared/billing/plans.ts).
      plan                   TEXT NOT NULL CHECK (plan IN ('free', 'starter', 'pro')),
      -- STRIPE's vocabulary, deliberately not ours. Translating their
      -- statuses would mean inventing our own answer for "unpaid" versus
      -- "past_due", and a support conversation held with their dashboard
      -- open is easier when the words match on both screens.
      status                 TEXT NOT NULL CHECK (status IN (
                               'trialing', 'active', 'past_due', 'canceled',
                               'incomplete', 'incomplete_expired', 'unpaid', 'paused')),
      cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
      -- Nullable: an incomplete subscription has no period yet.
      current_period_end     TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE TABLE stripe_events (
      -- Stripe's own event id (evt_…) as the primary key. That single
      -- choice IS the idempotency mechanism: the handler inserts first and
      -- treats a conflict as "already applied", so a webhook delivered
      -- twice — which Stripe does, by design, and more often when a
      -- response is slow — cannot double-apply. The alternative, a
      -- check-then-act read, races itself under exactly the retry storm it
      -- is meant to survive. Same stance as the handoff table's partial
      -- unique index (§3.3.4): dedupe by constraint, never by application
      -- logic.
      id          TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 255),
      type        TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // Retention, stated rather than assumed: this table only ever grows.
  // Stripe retries a failed webhook for up to ~3 days, so a row older than
  // a week can never be needed for deduplication again. There is no cron in
  // this system to prune it, and inventing one for a table that gains a few
  // rows per subscription change would be the wrong trade today — the index
  // below is what a prune would use when volume justifies writing it.
  await sql`
    CREATE INDEX stripe_events_received ON stripe_events (received_at)
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS stripe_events`.execute(db)
  await sql`DROP TABLE IF EXISTS subscriptions`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
