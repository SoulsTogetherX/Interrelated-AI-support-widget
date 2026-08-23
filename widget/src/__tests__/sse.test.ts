//#region Imports
import { describe, expect, it } from "vitest"

import { readAnswerEvents } from "../sse"
import type { AnswerEvent } from "@shared/grounding/events"
//#endregion

//#region Helpers
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

const bytes = (text: string) => new TextEncoder().encode(text)

async function collect(stream: ReadableStream<Uint8Array>): Promise<AnswerEvent[]> {
  const events: AnswerEvent[] = []
  for await (const event of readAnswerEvents(stream)) events.push(event)
  return events
}
//#endregion

describe("readAnswerEvents", () => {
  const meta = { type: "meta", conversationId: "con_1", messageId: "msg_1" }
  const done = { type: "done", claimsTotal: 1, claimsShown: 1 }

  it("parses one event per data frame", async () => {
    const events = await collect(streamOf(bytes(
      `data: ${JSON.stringify(meta)}\n\ndata: ${JSON.stringify(done)}\n\n`,
    )))
    expect(events).toEqual([meta, done])
  })

  it("reassembles a frame split across network chunks", async () => {
    const frame = `data: ${JSON.stringify(meta)}\n\n`
    const events = await collect(streamOf(bytes(frame.slice(0, 12)), bytes(frame.slice(12))))
    expect(events).toEqual([meta])
  })

  it("reassembles a multi-byte character split mid-encoding", async () => {
    const claim = { type: "claim", ord: 0, text: "café ☕", url: null, headingPath: null }
    const whole = bytes(`data: ${JSON.stringify(claim)}\n\n`)
    // Split inside the é (0xC3 0xA9).
    const cut = whole.indexOf(0xc3) + 1
    const events = await collect(streamOf(whole.subarray(0, cut), whole.subarray(cut)))
    expect(events).toEqual([claim])
  })

  it("ignores frames that are not data lines and empty streams", async () => {
    expect(await collect(streamOf(bytes(": keepalive\n\n")))).toEqual([])
    expect(await collect(streamOf())).toEqual([])
  })

  it("leaves a trailing partial frame unparsed — no half-JSON reaches the UI", async () => {
    const events = await collect(streamOf(bytes(`data: ${JSON.stringify(meta)}\n\ndata: {"type":"cl`)))
    expect(events).toEqual([meta])
  })
})
