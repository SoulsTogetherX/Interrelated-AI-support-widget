//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 002 — human handoff (M4.1): one row per escalation of a
// conversation from the bot to a person.
//
// Why a table rather than a column on conversations: an escalation has its
// own lifecycle (requested → claimed by an agent → closed), its own actors,
// and its own timestamps, and M5's headline product metric is
// time-to-first-human-response, which is a duration BETWEEN two of them. A
// conversation can also be escalated more than once over its life — resolved,
// re-opened later — and a column would overwrite the first escalation's
// history the moment the second happened. conversations.status stays the
// coarse state the widget renders; this table is the record.
//
// The load-bearing constraint is the partial unique index: at most one OPEN
// handoff per conversation. Double-escalation (a visitor mashing the button,
// or a retry racing itself) is then unrepresentable rather than deduplicated
// in application code — the same stance api_keys takes on live public ids,
// and it is what lets the escalate path be idempotent by construction
// instead of by a check-then-insert that races.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE handoff_sessions (
      id              TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'closed')),
      -- Why the visitor is talking to a human. 'low_confidence' is the
      -- auto-escalation path (a refusal the visitor did not accept);
      -- 'visitor_request' is the button. Both exist from day one because
      -- M5's deflection-rate metric is exactly the ratio between them, and
      -- adding an enum value later is a migration.
      reason          TEXT NOT NULL
                      CHECK (reason IN ('visitor_request', 'low_confidence')),
      -- The agent who took it. ON DELETE SET NULL, not CASCADE: a departed
      -- employee must not erase the history of conversations they handled.
      claimed_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
      requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at      TIMESTAMPTZ,
      closed_at       TIMESTAMPTZ,

      -- claimed_at is the invariant, not claimed_by. The two say different
      -- things: WHEN it was taken (a fact about the handoff, permanent) and
      -- BY WHOM (a fact about an account, which can be deleted). Tying
      -- 'active' to claimed_by instead would make ON DELETE SET NULL
      -- self-contradictory — deleting a departing employee would fail on a
      -- CHECK in a table nobody remembers exists, and an org would be unable
      -- to remove a member. A test deletes a user mid-handoff to pin this.
      CHECK (status <> 'active' OR claimed_at IS NOT NULL),
      CHECK ((status = 'closed') = (closed_at IS NOT NULL))
    )
  `.execute(db)

  // At most one OPEN handoff per conversation — the header's argument. A
  // closed one never blocks a later escalation, so a conversation can be
  // handed off, resolved, and handed off again.
  await sql`
    CREATE UNIQUE INDEX handoff_open_per_conversation
      ON handoff_sessions (conversation_id) WHERE status <> 'closed'
  `.execute(db)

  // The agent queue, and the only query the dashboard's inbox runs: this
  // org's waiting visitors, oldest first. Partial over pending rows only, so
  // the index stays the size of the QUEUE rather than of all history —
  // the same shape as ingest_jobs_queued.
  await sql`
    CREATE INDEX handoff_pending
      ON handoff_sessions (org_id, requested_at) WHERE status = 'pending'
  `.execute(db)

  // Every handoff of one conversation, newest first — the transcript view's
  // sidebar, and how a re-escalation finds its predecessor.
  await sql`
    CREATE INDEX handoff_conversation
      ON handoff_sessions (conversation_id, requested_at DESC)
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS handoff_sessions`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
