//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 009 — what an uploaded file leaves behind (M7.6b).
//
// `sources.kind` has allowed 'upload' since 001 and nothing could produce
// one: the crawler fetches URLs, and the worker failed an upload job loudly
// ("upload sources are not crawlable") because there was no other honest
// thing to do with it. This table is the missing half — one row per uploaded
// file, holding what the parser extracted from it.
//
// WHAT IS STORED IS THE TEXT, NEVER THE FILE. The bytes are parsed in the
// upload request and then dropped. That is not thrift for its own sake:
//
//   * The file has nowhere to go. There is no object storage in this
//     deployment, and Neon's 0.5 GB free tier holds ~78k chunks — a 10 MB
//     PDF would cost more than the ~800 chunks extracted from it, as a
//     second copy of the same content in the more expensive form. Nothing
//     would ever read it again: retrieval reads chunks, and a citation
//     deep-links by character offset into text we already have.
//   * Keeping a customer's uploaded file is a liability with no
//     corresponding asset — the org_provider_credentials argument (§3.3.3),
//     where retaining superseded ciphertexts was rejected for the same
//     reason.
//
// But the text is NOT transient, and this is the constraint that forced a
// table rather than a parse-and-forget route. When an org changes its
// embedding model, §3.22 re-queues every source, because chunk vectors are
// stored per (chunk, model) and a new model makes the old corpus invisible
// rather than wrong. A crawl source survives that by being fetched again.
// An upload has nothing to re-fetch — so unless the extracted text is kept,
// a model change would silently orphan every uploaded document and the
// tenant's widget would stop answering from them with no error anywhere.
// The stored text is what makes an upload a first-class source: re-indexable,
// re-chunkable, and re-crawlable in the one sense that means anything here.
//
// `blocks` holds SPANS ONLY — {kind, level?, charStart, charEnd} — and never
// the block's text. The parser contract is
//
//     block.text === text.slice(block.charStart, block.charEnd)
//
// (parsers/types.ts), so storing the text a second time inside the JSONB
// would double the row to record something the contract already determines,
// and would introduce the one way the two copies could ever disagree. The
// worker slices them back out, which makes the contract hold by construction
// on the way in and on the way out.
//
// One row per source, keyed BY the source (the natural-key argument: nothing
// references an upload row individually), and one file per source — a
// replacement is a new upload. ON DELETE CASCADE so removing a source takes
// its text with it.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE source_uploads (
      source_id   TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      -- The name the customer's file had. Shown in the dashboard where a
      -- crawl source shows its URL, and copied to documents.url so a
      -- citation from an uploaded file says where it came from.
      filename    TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
      -- Which parser read it ('pdf' | 'html' | 'markdown'), as DETECTED from
      -- the bytes rather than as declared by the browser: the dashboard says
      -- what was actually read, and a PDF sent as text/plain is still a PDF
      -- (parsers/index.ts leads its detection order with the magic bytes for
      -- exactly that reason).
      format      TEXT NOT NULL CHECK (format IN ('pdf', 'html', 'markdown')),
      -- The ORIGINAL file's size, kept as a fact about what the tenant
      -- handed over even though the file itself is gone. It is the only way
      -- the dashboard can say "2.1 MB PDF" about something it no longer has.
      byte_size   INT NOT NULL CHECK (byte_size > 0),
      title       TEXT,
      -- The canonical normalized extraction — what content_hash fingerprints
      -- and what every char offset points into.
      text        TEXT NOT NULL CHECK (char_length(text) > 0),
      -- Span-only blocks; see the note above. jsonb so the schema can insist
      -- on the shape, as 008 does for skipped_pages.
      blocks      JSONB NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS source_uploads`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
