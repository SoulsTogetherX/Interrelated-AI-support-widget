"use server"

//#region Server Actions
// Source mutations — same trust ladder as providers/actions.ts: signed-in
// → member → OWNER for writes (connecting a crawl target spends the org's
// embedding quota and changes what the widget answers from; that is org
// wiring, not conversation work).
//#endregion

//#region Imports
import { revalidatePath } from "next/cache"

import { currentUser } from "@/lib/auth/requireUser"
import { getOrgForMember } from "@/lib/orgs"
import { createSource, recrawlSource } from "@/lib/realtime"
import { isId } from "@shared/utils/ids"
//#endregion

//#region Types
export interface SourceFormState {
  error: string | null
  success: string | null
}
//#endregion

//#region Actions
export async function addSourceAction(
  _prev: SourceFormState,
  formData: FormData,
): Promise<SourceFormState> {
  const orgId = typeof formData.get("orgId") === "string" ? (formData.get("orgId") as string) : ""
  const user = await currentUser()
  if (!user) {
    return { error: "Your session expired — sign in again.", success: null }
  }
  const org = await getOrgForMember(orgId, user.id)
  if (!org) {
    return { error: "Organization not found.", success: null }
  }
  if (org.role !== "owner") {
    return { error: "Only the organization owner can connect sources.", success: null }
  }

  const kindRaw = formData.get("kind")
  const kind = kindRaw === "sitemap" ? "sitemap" : "url"
  const location = typeof formData.get("location") === "string"
    ? (formData.get("location") as string).trim()
    : ""
  const depthRaw = formData.get("crawlDepth")
  const crawlDepth = typeof depthRaw === "string" && depthRaw !== "" ? Number(depthRaw) : undefined

  const result = await createSource(orgId, {
    kind,
    location,
    ...(crawlDepth !== undefined ? { crawlDepth } : {}),
  })
  if (!result.ok) {
    return { error: result.error, success: null }
  }

  revalidatePath(`/dashboard/${orgId}/sources`)
  return {
    error: null,
    success: "Source connected — crawling starts now. Progress updates below.",
  }
}

/**
 * Re-crawl one source (M7.5) — a plain form action, like the install page's
 * one-click Allow: the re-rendered list IS the message (the source flips to
 * "queued…" and the auto-refresh takes it from there), so there is no state
 * to return. Same ladder as connecting a source, re-checked here because a
 * Server Action is reachable as a direct POST; realtime re-establishes that
 * the source belongs to the org regardless. A `queued: false` answer (a
 * crawl already queued or running) needs nothing said either — the page
 * already shows that state.
 */
export async function recrawlSourceAction(formData: FormData): Promise<void> {
  const orgId = typeof formData.get("orgId") === "string" ? (formData.get("orgId") as string) : ""
  const sourceId = typeof formData.get("sourceId") === "string" ? (formData.get("sourceId") as string) : ""
  if (!isId("src", sourceId)) {
    return
  }
  const user = await currentUser()
  if (!user) {
    return
  }
  const org = await getOrgForMember(orgId, user.id)
  if (!org || org.role !== "owner") {
    return
  }
  await recrawlSource(orgId, sourceId)
  revalidatePath(`/dashboard/${orgId}/sources`)
}
//#endregion
