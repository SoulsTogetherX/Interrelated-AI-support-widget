//#region Imports
import type { AnswerEvent } from "@shared/grounding/events"
//#endregion

//#region Parser
/**
 * SSE frames → AnswerEvents, from a fetch body stream. The browser twin of
 * realtime's sseData: same framing, same one-JSON-document-per-data-line
 * contract (shared/grounding/events.ts is the shared truth), re-implemented
 * here because the widget imports RUNTIME code from nowhere — the 15 KB
 * budget is why this package exists at all.
 *
 * TextDecoder runs in streaming mode: network chunk boundaries land
 * anywhere, including inside a multi-byte character of an answer in
 * French. Buffering splits on the blank-line frame delimiter, so a data
 * line split across two chunks reassembles instead of half-parsing.
 */
async function* readAnswerEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AnswerEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as AnswerEvent
      }
    }
  } finally {
    // Releasing the lock (rather than cancelling) lets the caller abandon
    // the iterator mid-stream — closing the panel — without killing the
    // fetch out from under an in-flight read.
    reader.releaseLock()
  }
}
//#endregion

//#region Exports
export { readAnswerEvents }
//#endregion
