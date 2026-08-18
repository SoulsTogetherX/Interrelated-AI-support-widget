//#region Why this file
// The server-to-server client for realtime's internal API — the dashboard
// half of the M3.4 credential path. Runs ONLY on the server (Server
// Actions import it; nothing client-side can, because the secret lives in
// env). The plaintext provider key exists web-side exactly here, exactly
// in transit: request body out, never logged, never stored, never in an
// error message.
//
// Config is two env vars: REALTIME_INTERNAL_URL (the Render service, or
// localhost:3000 in dev) and INTERNAL_API_SECRET (identical value on both
// services). Missing config is a NORMAL state — a fresh checkout or a
// Vercel preview without secrets — so it surfaces as a typed "not
// connected" result the UI can explain, not a crash.
//#endregion

//#region Types
export interface CredentialPayload {
  role: "generation" | "embedding"
  provider: string
  apiKey?: string
  baseUrl?: string
  model?: string
}

export type InternalResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export interface SaveOutcome {
  saved: boolean
  model: string
  latencyMs: number
  suffix: string | null
  /** Embedding role only: the dimension the live round-trip observed. */
  dim: number | null
  /** Sources re-queued for crawling because the embedding model changed —
   *  realtime does that in the same transaction as the save (§3.22), and
   *  the number exists so the dashboard can say so out loud instead of
   *  leaving a tenant to wonder why their crawls restarted. */
  reindexed: number
}
//#endregion

//#region Config
function config(): { baseUrl: string; secret: string } | null {
  const baseUrl = process.env.REALTIME_INTERNAL_URL
  const secret = process.env.INTERNAL_API_SECRET
  if (!baseUrl || !secret) {
    return null
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), secret }
}

const NOT_CONNECTED =
  "The dashboard is not connected to the realtime service — " +
  "REALTIME_INTERNAL_URL and INTERNAL_API_SECRET must both be set."
//#endregion

//#region Calls
async function call(
  path: string,
  init: { method: string; body?: unknown },
): Promise<InternalResult<Record<string, unknown>>> {
  const cfg = config()
  if (!cfg) {
    return { ok: false, error: NOT_CONNECTED }
  }
  let res: Response
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        "x-internal-secret": cfg.secret,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      // Credential operations must never be cached by Next's fetch layer.
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return { ok: false, error: "Could not reach the realtime service." }
  }

  if (res.status === 401) {
    // A secret mismatch is an OPERATOR error, and saying so beats a
    // generic failure the tenant will retry forever.
    return { ok: false, error: "The internal API secret is misconfigured (401)." }
  }
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // Non-JSON body (404 .end(), proxies) — fall through to status check.
  }
  if (!res.ok) {
    const error = typeof body.error === "string" ? body.error : `Request failed (${res.status}).`
    return { ok: false, error }
  }
  return { ok: true, value: body }
}

/** Test (save=false) or save a credential — one call shape because the
 *  server keeps them one code path. */
export async function submitCredential(
  orgId: string,
  payload: CredentialPayload,
  save: boolean,
): Promise<InternalResult<SaveOutcome>> {
  const result = await call(`/internal/orgs/${orgId}/credentials`, {
    method: "POST",
    body: { ...payload, save },
  })
  if (!result.ok) {
    return result
  }
  const v = result.value
  return {
    ok: true,
    value: {
      saved: v.saved === true,
      model: typeof v.model === "string" ? v.model : "unknown",
      latencyMs: typeof v.latencyMs === "number" ? v.latencyMs : 0,
      suffix: typeof v.suffix === "string" ? v.suffix : null,
      dim: typeof v.dim === "number" ? v.dim : null,
      reindexed: typeof v.reindexed === "number" ? v.reindexed : 0,
    },
  }
}

export async function removeCredential(
  orgId: string,
  role: "generation" | "embedding",
): Promise<InternalResult<{ reindexed: number }>> {
  const result = await call(`/internal/orgs/${orgId}/credentials/${role}`, {
    method: "DELETE",
  })
  if (!result.ok) {
    return result
  }
  const v = result.value
  return { ok: true, value: { reindexed: typeof v.reindexed === "number" ? v.reindexed : 0 } }
}

/**
 * A 60-second single-use ticket for the handoff socket (M4.5), minted for
 * an AGENT. It goes through realtime rather than being signed here because
 * the signing key is derived from WIDGET_TOKEN_SECRET (§3.24), which lives
 * on the realtime service alone — the dashboard proving who the agent is
 * and realtime deciding what that is worth is the same split as
 * credentials: web knows the person, realtime holds the keys.
 *
 * Realtime re-checks membership and that the handoff is still open, so
 * this is not the only line of defense — but the caller must still do the
 * checks in actions.ts, because a Server Action is a public POST endpoint.
 */
export async function mintHandoffTicket(
  orgId: string,
  conversationId: string,
  userId: string,
): Promise<InternalResult<{ ticket: string }>> {
  const result = await call(`/internal/orgs/${orgId}/handoff-tickets`, {
    method: "POST",
    body: { conversationId, userId },
  })
  if (!result.ok) {
    return result
  }
  const ticket = result.value.ticket
  if (typeof ticket !== "string" || ticket === "") {
    return { ok: false, error: "The realtime service returned no ticket." }
  }
  return { ok: true, value: { ticket } }
}

/**
 * Close a handoff (M4.6). Through realtime rather than written here —
 * unlike the origin allowlist, which web owns outright (§9.11) — because
 * closing has an in-process consequence: the socket rooms live in that
 * service, and the two people in the conversation must be TOLD it ended.
 *
 * `closed: false` means there was nothing open, which is a normal answer
 * (a double click, or a colleague who got there first), not a failure.
 */
export async function closeHandoff(
  orgId: string,
  conversationId: string,
  userId: string,
): Promise<InternalResult<{ closed: boolean }>> {
  const result = await call(`/internal/orgs/${orgId}/handoffs/${conversationId}/close`, {
    method: "POST",
    body: { userId },
  })
  if (!result.ok) {
    return result
  }
  return { ok: true, value: { closed: result.value.closed === true } }
}

/** Connect a source and enqueue its first crawl (M3.6). The realtime side
 *  vets the URL (SSRF), writes source + job in one transaction, and wakes
 *  the ingest worker — the enqueue IS production's scheduler. */
export async function createSource(
  orgId: string,
  payload: { kind: "url" | "sitemap"; location: string; crawlDepth?: number },
): Promise<InternalResult<{ sourceId: string; jobId: string }>> {
  const result = await call(`/internal/orgs/${orgId}/sources`, {
    method: "POST",
    body: payload,
  })
  if (!result.ok) {
    return result
  }
  const v = result.value
  return {
    ok: true,
    value: {
      sourceId: typeof v.sourceId === "string" ? v.sourceId : "",
      jobId: typeof v.jobId === "string" ? v.jobId : "",
    },
  }
}

/** Queue a fresh crawl of one source (M7.5) — through realtime for the same
 *  reason connecting one is: the job row is not the whole effect, the wake
 *  is. `queued: false` is a normal answer (a crawl is already queued or
 *  running), not an error. */
export async function recrawlSource(
  orgId: string,
  sourceId: string,
): Promise<InternalResult<{ queued: boolean }>> {
  const result = await call(`/internal/orgs/${orgId}/sources/${sourceId}/recrawl`, { method: "POST" })
  if (!result.ok) {
    return result
  }
  return { ok: true, value: { queued: result.value.queued === true } }
}
//#endregion
