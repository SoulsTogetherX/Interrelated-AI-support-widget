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
import { createSource, deleteSource, recrawlSource, uploadSource } from "@/lib/realtime"
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
  const location =
    typeof formData.get("location") === "string" ? (formData.get("location") as string).trim() : ""
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
 * Upload a file as a source (M7.6b). Same ladder as connecting a crawl
 * source, and for the same reason: an upload spends the org's embedding
 * quota and changes what the widget answers from.
 *
 * useActionState-shaped rather than a plain action (which is what Re-crawl
 * below is), because an upload is the one source operation that can fail for
 * reasons only the FILE knows — a scan with no text layer, a
 * password-protected PDF, a document that parsed to nothing. Those sentences
 * are the most useful thing this surface produces, and they have to land
 * somewhere the tenant is looking.
 *
 * The file is read into memory here and forwarded. Next has already buffered
 * it to parse the FormData, so this adds no ceiling that was not already
 * there; the cap that matters is realtime's, which answers 413 with the
 * number in it.
 */
export async function uploadSourceAction(
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
    return { error: "Only the organization owner can add sources.", success: null }
  }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload.", success: null }
  }

  const result = await uploadSource(orgId, {
    name: file.name,
    type: file.type,
    bytes: await file.arrayBuffer(),
  })
  if (!result.ok) {
    return { error: result.error, success: null }
  }

  revalidatePath(`/dashboard/${orgId}/sources`)
  // The character count is the honest answer to "did that work?" before the
  // embedding has run — and the only one available about a file the service
  // deliberately did not keep.
  return {
    error: null,
    success: `${result.value.filename} read — ${result.value.charCount.toLocaleString()} characters of text. Indexing starts now.`,
  }
}

/**
 * Re-crawl one source (M7.5), or re-index an uploaded file from its stored
 * text (M7.6b) — a plain form action, like the install page's
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
  const sourceId =
    typeof formData.get("sourceId") === "string" ? (formData.get("sourceId") as string) : ""
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

/**
 * Delete a source (M8.5) — a plain form action for Re-crawl's reason: the
 * re-rendered list IS the message, the row disappearing along with a slot
 * against the plan's ceiling. The one refusal realtime can answer (a crawl
 * of the source is RUNNING, 409) also needs nothing said here: the row
 * stays, visibly in its crawling state, and the delete works the moment the
 * crawl finishes. Owner-only, re-checked because a Server Action is
 * reachable as a direct POST; realtime re-establishes that the source
 * belongs to the org regardless.
 */
export async function deleteSourceAction(formData: FormData): Promise<void> {
  const orgId = typeof formData.get("orgId") === "string" ? (formData.get("orgId") as string) : ""
  const sourceId =
    typeof formData.get("sourceId") === "string" ? (formData.get("sourceId") as string) : ""
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
  await deleteSource(orgId, sourceId)
  revalidatePath(`/dashboard/${orgId}/sources`)
}
//#endregion
