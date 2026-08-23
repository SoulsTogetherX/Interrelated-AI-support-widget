//#region Type Defs
/**
 * Shared plumbing for the HTTP-backed LLM providers. Zero imports on
 * purpose: fetch, ReadableStream, and TextDecoder are Node 22 globals (and
 * browser globals), so providers/ keeps its no-package-json rule (§2.4.5)
 * without even a dynamic import — unlike fastembed, talking to an LLM API
 * is just HTTP.
 */

/**
 * A non-2xx response from a provider, with the two fields callers act on:
 * status (429 and 5xx get different treatment) and retryAfterMs when the
 * server said how long to wait. Retry POLICY stays with the caller per the
 * LLMProvider contract — the M2.5 queue implements jittered backoff for
 * interactive traffic; this error just carries the facts.
 *
 * Key safety: the message includes the provider label, status, and a
 * TRUNCATED response body — never request headers, never the URL (a
 * misconfigured base URL could embed credentials, and error messages end
 * up in logs).
 */
class LLMHttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | null
  constructor(options: { provider: string; status: number; detail: string; retryAfterMs?: number | null }) {
    super(`${options.provider}: HTTP ${options.status}: ${options.detail}`)
    this.name = "LLMHttpError"
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}
//#endregion

//#region HTTP
/**
 * POSTs JSON and returns the response BODY stream, raising LLMHttpError on
 * non-2xx. The one place provider requests leave the process, so the
 * key-safety rule above has a single enforcement point.
 */
async function postStream(options: {
  provider: string
  url: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
}): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(options.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(options.body),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  if (!response.ok) {
    // Read the body for the diagnostic (providers put "model not found" and
    // quota messages there), truncated so a hostile or broken server can't
    // balloon logs.
    let detail = ""
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      detail = "(unreadable body)"
    }
    // Retry-After arrives as delta-seconds on every provider we speak to;
    // the HTTP-date form is legal but unseen here, and parsing it wrong is
    // worse than reporting null.
    const retryAfterHeader = response.headers.get("retry-after")
    const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN
    throw new LLMHttpError({
      provider: options.provider,
      status: response.status,
      detail,
      retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : null,
    })
  }
  if (response.body === null) {
    throw new LLMHttpError({ provider: options.provider, status: response.status, detail: "response has no body" })
  }
  return response.body
}
//#endregion

//#region Stream decoding
/**
 * Byte stream → lines, CRLF-tolerant. TextDecoder runs in streaming mode
 * because chunk boundaries land wherever the socket pleases — including
 * mid-multibyte-character; a naive per-chunk decode corrupts exactly the
 * answers containing non-ASCII text (and a test splits "café" mid-é to
 * prove this survives).
 */
async function* byteLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
    }
  }
  buffer += decoder.decode()
  if (buffer.length > 0) yield buffer.replace(/\r$/, "")
}

/**
 * SSE stream → the payload of each `data:` line. Deliberately minimal: the
 * OpenAI-style and Gemini streams put one complete JSON document per data
 * line and use no other SSE fields, so event/id/retry handling and
 * multi-line data reassembly would be dead code with a test burden.
 */
async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of byteLines(stream)) {
    if (line.startsWith("data:")) yield line.slice(5).trim()
  }
}

/** NDJSON stream (Ollama's native framing) → parsed objects. A malformed
 *  line throws — that is a transport failure, and the LLMProvider contract
 *  says transport failures throw. */
async function* ndjsonObjects(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  for await (const line of byteLines(stream)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) yield JSON.parse(trimmed) as unknown
  }
}
//#endregion

//#region Exports
export { LLMHttpError, postStream, byteLines, sseData, ndjsonObjects }
//#endregion
