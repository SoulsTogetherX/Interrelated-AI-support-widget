// The schema types LIVE in shared/db/schema.ts since M3.2 — the dashboard
// (web/) types its queries against the same tables, which makes the table
// shapes a cross-package contract, and shared/ is where those live. This
// re-export keeps every realtime-internal `@/db/schema` import reading
// unchanged, and keeps the ownership statement true: realtime's migrations
// are still the ONLY thing that changes the database — web never migrates.
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
  DocumentsTable,
  ChunksTable,
  ChunkEmbeddingsTable,
  IngestJobsTable,
  SkippedPage,
  ConversationsTable,
  MessagesTable,
  MessageCitationsTable,
} from "@shared/db/schema"
export { MAX_RECORDED_SKIPPED_PAGES } from "@shared/db/schema"
