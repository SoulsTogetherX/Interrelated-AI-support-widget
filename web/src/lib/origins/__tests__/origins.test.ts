// DB-gated integration suite (self-skips without POSTGRES_PASSWORD; schema
// must already be migrated — same prerequisite and CI ordering as
// lib/auth/__tests__/authFlow.test.ts, which states it in full).
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { addOrigin, listOrigins, removeOrigin } from "../index"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)
const RUN = Math.random().toString(36).slice(2, 10)

let orgId: string
let otherOrgId: string

describe.skipIf(!hasDb)("origin allowlist (integration)", () => {
  beforeAll(async () => {
    orgId = newId("org")
    otherOrgId = newId("org")
    await db
      .insertInto("organizations")
      .values([
        { id: orgId, name: `Origins Co ${RUN}` },
        { id: otherOrgId, name: `Other Origins Co ${RUN}` },
      ])
      .execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "in", [orgId, otherOrgId]).execute()
    await db.destroy()
  })

  it("adds, lists in insertion order, and removes", async () => {
    await addOrigin(orgId, "https://first.example")
    await addOrigin(orgId, "https://second.example")
    expect((await listOrigins(orgId)).map((o) => o.origin)).toEqual([
      "https://first.example",
      "https://second.example",
    ])

    await removeOrigin(orgId, "https://first.example")
    expect((await listOrigins(orgId)).map((o) => o.origin)).toEqual(["https://second.example"])
  })

  it("is idempotent: re-adding an existing origin is a no-op success", async () => {
    // The tenant's intent is already satisfied; a duplicate-key error would
    // be noise, and the composite PK makes the row unique regardless.
    await addOrigin(orgId, "https://second.example")
    await addOrigin(orgId, "https://second.example")
    expect(await listOrigins(orgId)).toHaveLength(1)
  })

  it("removing an absent origin is silent, not an error", async () => {
    await removeOrigin(orgId, "https://never-added.example")
    expect(await listOrigins(orgId)).toHaveLength(1)
  })

  it("scopes every operation to the org", async () => {
    await addOrigin(otherOrgId, "https://tenant-b.example")
    expect((await listOrigins(orgId)).map((o) => o.origin)).toEqual(["https://second.example"])
    expect((await listOrigins(otherOrgId)).map((o) => o.origin)).toEqual([
      "https://tenant-b.example",
    ])

    // A delete aimed at another tenant's row must not touch it — the
    // action's org scoping is what makes cross-tenant removal impossible.
    await removeOrigin(orgId, "https://tenant-b.example")
    expect(await listOrigins(otherOrgId)).toHaveLength(1)
  })

  it("the schema CHECK rejects a path or trailing slash if validation is bypassed", async () => {
    // The backstop behind validateOrigin: even a direct write cannot store
    // a string the widget route could never match.
    await expect(addOrigin(orgId, "https://bad.example/")).rejects.toThrow()
    await expect(addOrigin(orgId, "https://bad.example/path")).rejects.toThrow()
  })
})
