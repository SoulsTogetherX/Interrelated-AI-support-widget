//#region Why this file
// The vault's READ side (§3.21's resolve.ts), which had no suite of its own
// until M7.8 made a behavioral claim worth pinning: a stored credential
// naming ANY of the schema's five providers now resolves to a working
// adapter. Until this increment `anthropic` was forward provision — the
// CHECK constraint allowed it, `shared/db/schema.ts` typed it, and
// loadCredential threw "anthropic credentials have no adapter yet" — so the
// row shape and the code disagreed about what a valid credential was.
//
// These cases need no network: resolution ENDS at a constructed provider,
// and what it constructs (and under which model) is the whole question. The
// call itself is the key-gated live suite's job.
//#endregion

//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { encryptProviderKey, keySuffix } from "@/credentials/vault"
import { resolveEmbeddingProvider, resolveGenerationProvider } from "@/credentials/resolve"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Setup
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)
const TENANT_KEY = "sk-ant-resolve-suite-key-000000"

let orgId: string
let bareOrgId: string

/** One credential row, encrypted exactly as the internal API stores it —
 *  AAD-bound to the row id, so a resolve that decrypts proves the binding
 *  as a side effect. */
async function seedCredential(options: {
  orgId: string
  role: "generation" | "embedding"
  provider: "groq" | "gemini" | "ollama" | "openai_compatible" | "anthropic"
  model: string | null
  apiKey: string | null
  baseUrl?: string
  dim?: number
}): Promise<void> {
  const id = newId("prv")
  await db
    .insertInto("org_provider_credentials")
    .values({
      id,
      org_id: options.orgId,
      role: options.role,
      provider: options.provider,
      model: options.model,
      base_url: options.baseUrl ?? null,
      key_ciphertext: options.apiKey === null ? null : encryptProviderKey(options.apiKey, id),
      key_suffix: options.apiKey === null ? null : keySuffix(options.apiKey),
      dim: options.dim ?? null,
    })
    .execute()
}

beforeAll(async () => {
  if (!DB_CONFIGURED) return
  process.env.CREDENTIAL_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64")
  await migrateToLatest(db)
  orgId = newId("org")
  bareOrgId = newId("org")
  await db.insertInto("organizations").values({ id: orgId, name: "Resolve Suite" }).execute()
  await db.insertInto("organizations").values({ id: bareOrgId, name: "Resolve Suite (bare)" }).execute()
})

afterAll(async () => {
  if (DB_CONFIGURED) {
    await db.deleteFrom("organizations").where("id", "in", [orgId, bareOrgId]).execute()
  }
  await pool.end()
})
//#endregion

describe.skipIf(!DB_CONFIGURED)("credential resolution", () => {
  it("resolves an anthropic generation row — the forward-provision branch is gone", async () => {
    // The regression this file exists for. Before M7.8 this threw, which
    // meant a provider the SCHEMA accepts could be stored and then break
    // every answer for that tenant at question time.
    await seedCredential({
      orgId,
      role: "generation",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      apiKey: TENANT_KEY,
    })
    const provider = await resolveGenerationProvider(db, orgId)
    expect(provider).not.toBeNull()
    // The model the row named, not the adapter's default: it is what lands
    // in messages.model, so the by-model metrics and the price lookup both
    // hang off this being the tenant's actual choice.
    expect(provider!.model).toBe("claude-haiku-4-5-20251001")
  })

  it("falls back to the adapter's default when the row names no model", async () => {
    await db.deleteFrom("org_provider_credentials").where("org_id", "=", orgId).execute()
    await seedCredential({ orgId, role: "generation", provider: "anthropic", model: null, apiKey: TENANT_KEY })
    const provider = await resolveGenerationProvider(db, orgId)
    expect(provider!.model).toBe("claude-haiku-4-5-20251001")
  })

  it("returns null for an org with no credential — the NORMAL fallback state", async () => {
    // Absence is not an error: the demo org and every fresh org land here
    // and the caller uses the app-level provider (§3.21).
    expect(await resolveGenerationProvider(db, bareOrgId)).toBeNull()
    expect(await resolveEmbeddingProvider(db, bareOrgId)).toBeNull()
  })

  it("throws by name if an anthropic EMBEDDING row somehow exists", async () => {
    // Unrepresentable through the internal API, which refuses the pairing
    // with a sentence — so reaching this means the row was written around
    // the route, and a loud stop beats embedding a corpus with a provider
    // that has no embeddings endpoint.
    await seedCredential({
      orgId, role: "embedding", provider: "anthropic", model: "claude-haiku-4-5-20251001",
      apiKey: TENANT_KEY, dim: 768,
    })
    await expect(resolveEmbeddingProvider(db, orgId)).rejects.toThrow(/anthropic has no embedding endpoint/)
  })
})
