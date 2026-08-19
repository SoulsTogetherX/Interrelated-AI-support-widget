//#region Imports
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

import { LLMHttpError } from "../http"
import { OpenAICompatibleProvider } from "../openaiCompatible"
import { GroqProvider } from "../groq"
import { GeminiProvider } from "../gemini"
import { OllamaProvider } from "../ollama"
import { AnthropicProvider } from "../anthropic"
import type { LLMRequest, LLMStreamEvent } from "../types"
//#endregion

//#region Test Setup
// The HTTP providers against in-test loopback servers speaking each wire
// protocol — the same pattern as safeFetch's tests: keyless, deterministic,
// and exercising real sockets end to end (chunk boundaries included).

interface Captured {
  url: string
  headers: IncomingMessage["headers"]
  body: unknown
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
  servers.length = 0
})

/** Boots a loopback server; `handle` gets the parsed request body and the
 *  raw response. Returns the base URL and the capture slot. */
async function boot(
  handle: (captured: Captured, res: ServerResponse) => void,
): Promise<{ baseUrl: string; captured: () => Captured }> {
  let captured: Captured | undefined
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      captured = {
        url: req.url ?? "",
        headers: req.headers,
        body: raw.length > 0 ? JSON.parse(raw) : null,
      }
      handle(captured, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured: () => {
      if (!captured) throw new Error("server saw no request")
      return captured
    },
  }
}

function sse(res: ServerResponse, payloads: readonly string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const payload of payloads) res.write(`data: ${payload}\n\n`)
  res.end()
}

const request: LLMRequest = {
  messages: [
    { role: "system", content: "answer as JSON" },
    { role: "user", content: "question" },
  ],
  temperature: 0,
  maxTokens: 256,
  responseSchema: { type: "object", required: ["claims"] },
}

async function collect(events: AsyncIterable<LLMStreamEvent>) {
  const deltas: string[] = []
  let done: Extract<LLMStreamEvent, { type: "done" }> | undefined
  for await (const event of events) {
    if (event.type === "delta") deltas.push(event.text)
    else done = event
  }
  return { deltas, text: deltas.join(""), done }
}
//#endregion

describe("OpenAICompatibleProvider", () => {
  const chunk = (delta: string) => JSON.stringify({ choices: [{ delta: { content: delta } }] })
  const finish = JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 12 },
  })

  it("streams deltas, maps the finish, reads usage, and sends the right request", async () => {
    const { baseUrl, captured } = await boot((_, res) => sse(res, [chunk("Hel"), chunk("lo"), finish, "[DONE]"]))
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model", apiKey: "sk-test" })
    const { text, done } = await collect(provider.stream(request))

    expect(text).toBe("Hello")
    expect(done).toEqual({ type: "done", finishReason: "stop", usage: { inputTokens: 40, outputTokens: 12 } })

    const sent = captured()
    expect(sent.url).toBe("/chat/completions")
    expect(sent.headers.authorization).toBe("Bearer sk-test")
    const body = sent.body as Record<string, unknown>
    expect(body["model"]).toBe("test-model")
    expect(body["stream"]).toBe(true)
    expect(body["temperature"]).toBe(0)
    expect(body["max_tokens"]).toBe(256)
    // json_object is the compat lowest common denominator; the schema
    // itself is NOT sent (enforcement is the pipeline's validator).
    expect(body["response_format"]).toEqual({ type: "json_object" })
    expect(body["messages"]).toEqual(request.messages)
  })

  it("reassembles multi-byte characters split across socket chunks", async () => {
    const payload = `data: ${chunk("café ☕")}\n\ndata: [DONE]\n\n`
    const bytes = Buffer.from(payload, "utf8")
    // Split INSIDE the é (0xC3 0xA9): a per-chunk decode corrupts this.
    const splitAt = bytes.indexOf(0xc3) + 1
    const { baseUrl } = await boot((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(bytes.subarray(0, splitAt))
      // Flush the second half on the next tick so two real TCP writes land.
      setTimeout(() => { res.write(bytes.subarray(splitAt)); res.end() }, 5)
    })
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "m" })
    const { text } = await collect(provider.stream(request))
    expect(text).toBe("café ☕")
  })

  it("maps a length cutoff and reads Groq's x_groq usage placement", async () => {
    const groqFinal = JSON.stringify({
      choices: [{ delta: {}, finish_reason: "length" }],
      x_groq: { usage: { prompt_tokens: 9, completion_tokens: 256 } },
    })
    const { baseUrl } = await boot((_, res) => sse(res, [chunk("truncated {"), groqFinal, "[DONE]"]))
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "m" })
    const { done } = await collect(provider.stream(request))
    expect(done).toEqual({ type: "done", finishReason: "length", usage: { inputTokens: 9, outputTokens: 256 } })
  })

  it("omits authorization when keyless and response_format when jsonMode is none", async () => {
    const { baseUrl, captured } = await boot((_, res) => sse(res, ["[DONE]"]))
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "m", jsonMode: "none" })
    await collect(provider.stream(request))
    expect(captured().headers.authorization).toBeUndefined()
    expect((captured().body as Record<string, unknown>)["response_format"]).toBeUndefined()
  })

  it("throws LLMHttpError with status, retry delay, and NO credentials on 429", async () => {
    const { baseUrl } = await boot((_, res) => {
      res.writeHead(429, { "retry-after": "7" })
      res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }))
    })
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "m", apiKey: "sk-SECRET" })
    const failure = await collect(provider.stream(request)).then(() => null, (e: unknown) => e)
    expect(failure).toBeInstanceOf(LLMHttpError)
    const error = failure as LLMHttpError
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(7000)
    expect(error.message).toContain("rate limit exceeded")
    expect(error.message).not.toContain("sk-SECRET")
  })

  it("throws on a mid-stream abort instead of yielding further deltas", async () => {
    const { baseUrl } = await boot((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${chunk("first")}\n\n`)
      // Never ends — only the abort can terminate the stream.
    })
    const controller = new AbortController()
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "m" })
    const iterator = provider.stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toEqual({ type: "delta", text: "first" })
    controller.abort()
    await expect(iterator.next()).rejects.toThrow()
  })
})

describe("GroqProvider", () => {
  it("is the compat adapter pinned to Groq's shape (verified via a base-URL stand-in)", async () => {
    // The real base URL constant is not reachable from tests; what IS
    // testable is that the preset speaks the compat protocol with Groq's
    // defaults. instanceof pins the no-duplicate-stream-loop decision.
    expect(new GroqProvider({ apiKey: "k" })).toBeInstanceOf(OpenAICompatibleProvider)
    expect(new GroqProvider({ apiKey: "k" }).model).toBe("llama-3.3-70b-versatile")
    expect(new GroqProvider({ apiKey: "k", model: "custom" }).model).toBe("custom")
  })
})

describe("GeminiProvider", () => {
  const part = (text: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })
  const final = JSON.stringify({
    candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  })

  it("streams parts, maps STOP, reads usageMetadata, and speaks Gemini's dialect", async () => {
    const { baseUrl, captured } = await boot((_, res) => sse(res, [part("Hel"), part("lo"), final]))
    const provider = new GeminiProvider({ apiKey: "g-test", baseUrl })
    const { text, done } = await collect(provider.stream(request))

    expect(text).toBe("Hello!")
    expect(done).toEqual({ type: "done", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20 } })

    const sent = captured()
    expect(sent.url).toBe("/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse")
    // Header auth, never ?key= — URLs land in logs.
    expect(sent.headers["x-goog-api-key"]).toBe("g-test")
    expect(sent.url).not.toContain("key=")
    const body = sent.body as Record<string, unknown>
    expect(body["systemInstruction"]).toEqual({ parts: [{ text: "answer as JSON" }] })
    expect(body["contents"]).toEqual([{ role: "user", parts: [{ text: "question" }] }])
    const config = body["generationConfig"] as Record<string, unknown>
    expect(config["temperature"]).toBe(0)
    expect(config["maxOutputTokens"]).toBe(256)
    expect(config["responseMimeType"]).toBe("application/json")
    // The schema goes up VERBATIM — real server-side enforcement.
    expect(config["responseJsonSchema"]).toEqual(request.responseSchema)
  })

  it("renames assistant turns to model turns", async () => {
    const { baseUrl, captured } = await boot((_, res) => sse(res, [final]))
    const provider = new GeminiProvider({ apiKey: "k", baseUrl })
    await collect(provider.stream({
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    }))
    const contents = (captured().body as Record<string, unknown>)["contents"] as Array<{ role: string }>
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"])
  })

  it("maps MAX_TOKENS to length", async () => {
    const cutoff = JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] })
    const { baseUrl } = await boot((_, res) => sse(res, [part("x"), cutoff]))
    const provider = new GeminiProvider({ apiKey: "k", baseUrl })
    const { done } = await collect(provider.stream(request))
    expect(done!.finishReason).toBe("length")
  })
})

describe("OllamaProvider", () => {
  const line = (content: string) => JSON.stringify({ message: { content }, done: false })
  const final = JSON.stringify({
    message: { content: "" }, done: true, done_reason: "stop",
    prompt_eval_count: 33, eval_count: 11,
  })

  it("streams NDJSON, maps done_reason, reads eval counts, and sends format", async () => {
    const { baseUrl, captured } = await boot((_, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" })
      res.end([line("Hel"), line("lo"), final].join("\n") + "\n")
    })
    const provider = new OllamaProvider({ model: "llama3.2", baseUrl })
    const { text, done } = await collect(provider.stream(request))

    expect(text).toBe("Hello")
    expect(done).toEqual({ type: "done", finishReason: "stop", usage: { inputTokens: 33, outputTokens: 11 } })

    const sent = captured()
    expect(sent.url).toBe("/api/chat")
    expect(sent.headers.authorization).toBeUndefined()
    const body = sent.body as Record<string, unknown>
    expect(body["model"]).toBe("llama3.2")
    // The native endpoint takes the FULL schema — the reason this is not
    // the compat adapter.
    expect(body["format"]).toEqual(request.responseSchema)
    expect(body["options"]).toEqual({ temperature: 0, num_predict: 256 })
    expect(body["messages"]).toEqual(request.messages)
  })

  it("maps a length cutoff", async () => {
    const cutoff = JSON.stringify({ message: { content: "" }, done: true, done_reason: "length" })
    const { baseUrl } = await boot((_, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" })
      res.end(line("partial") + "\n" + cutoff + "\n")
    })
    const provider = new OllamaProvider({ model: "m", baseUrl })
    const { done } = await collect(provider.stream(request))
    expect(done!.finishReason).toBe("length")
  })

  it("surfaces connection failure as a thrown error — the down-server experience", async () => {
    // Port 1 is never listening; the provider must throw, not hang or
    // yield an empty stream (the pipeline tells the visitor, not waits).
    const provider = new OllamaProvider({ model: "m", baseUrl: "http://127.0.0.1:1" })
    await expect(collect(provider.stream(request))).rejects.toThrow()
  })
})

describe("AnthropicProvider", () => {
  // Anthropic's streams carry BOTH an `event:` line and a `data:` line, and
  // the payload restates the event name in its own `type`. Every fixture
  // here writes the real two-line framing, which is what proves sseData's
  // deliberate blindness to `event:` costs this provider nothing.
  function events(res: ServerResponse, payloads: readonly Record<string, unknown>[]): void {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const payload of payloads) {
      res.write(`event: ${String(payload["type"])}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    res.end()
  }

  const start = {
    type: "message_start",
    message: { usage: { input_tokens: 120, output_tokens: 1 } },
  }
  const toolStart = { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "emit_answer" } }
  const json = (partial_json: string) => ({
    type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json },
  })
  const blockStop = { type: "content_block_stop", index: 0 }
  const messageDelta = (stopReason: string) => ({
    type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 34 },
  })
  const messageStop = { type: "message_stop" }

  it("streams the forced tool's arguments as the answer text, and speaks Anthropic's dialect", async () => {
    const { baseUrl, captured } = await boot((_, res) =>
      events(res, [
        start,
        { type: "ping" },
        toolStart,
        json('{"claims":'),
        json('[{"text":"a"}]}'),
        blockStop,
        messageDelta("tool_use"),
        messageStop,
      ]),
    )
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", baseUrl })
    const { text, done } = await collect(provider.stream(request))

    // The concatenated input_json_delta fragments ARE the response text —
    // the whole reason forced tool use fits the LLMProvider contract with
    // no special case downstream.
    expect(text).toBe('{"claims":[{"text":"a"}]}')
    // stop_reason "tool_use" is a NORMAL completion under a forced tool.
    // Input tokens come from message_start, output from message_delta;
    // neither event carries both.
    expect(done).toEqual({ type: "done", finishReason: "stop", usage: { inputTokens: 120, outputTokens: 34 } })

    const sent = captured()
    expect(sent.url).toBe("/v1/messages")
    expect(sent.headers["x-api-key"]).toBe("sk-ant-test")
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01")
    expect(sent.headers.authorization).toBeUndefined()
    const body = sent.body as Record<string, unknown>
    expect(body["model"]).toBe("claude-haiku-4-5-20251001")
    expect(body["stream"]).toBe(true)
    expect(body["temperature"]).toBe(0)
    expect(body["max_tokens"]).toBe(256)
    // System text is a top-level field, and the turn roles are already ours
    // (unlike Gemini, "assistant" stays "assistant").
    expect(body["system"]).toBe("answer as JSON")
    expect(body["messages"]).toEqual([{ role: "user", content: "question" }])
    // The schema goes up VERBATIM as the tool's input_schema, and the tool
    // is FORCED — the model cannot answer any other way.
    expect(body["tools"]).toEqual([
      {
        name: "emit_answer",
        description: "Return the answer as structured claims. This is the only way to reply.",
        input_schema: request.responseSchema,
      },
    ])
    expect(body["tool_choice"]).toEqual({ type: "tool", name: "emit_answer" })
  })

  it("keeps assistant turns and sends max_tokens even when the caller omits one", async () => {
    // max_tokens is REQUIRED by the Messages API — the one provider here
    // where omitting it is a 400 rather than "use your default".
    const { baseUrl, captured } = await boot((_, res) => events(res, [start, messageDelta("end_turn"), messageStop]))
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl })
    await collect(provider.stream({
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    }))
    const body = captured().body as Record<string, unknown>
    expect(body["max_tokens"]).toBe(1024)
    expect(body["messages"]).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ])
    // No schema asked for, so no tool is declared and nothing is forced.
    expect(body["tools"]).toBeUndefined()
    expect(body["tool_choice"]).toBeUndefined()
    expect(body["system"]).toBeUndefined()
  })

  it("streams ordinary text deltas when no schema is requested", async () => {
    const text = (t: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })
    const { baseUrl } = await boot((_, res) =>
      events(res, [
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        text("Hel"), text("lo"),
        blockStop, messageDelta("end_turn"), messageStop,
      ]),
    )
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl })
    const { text: answer, done } = await collect(provider.stream({ messages: [{ role: "user", content: "hi" }] }))
    expect(answer).toBe("Hello")
    expect(done!.finishReason).toBe("stop")
  })

  it("drops prose emitted beside the tool call instead of splicing it into the JSON", async () => {
    // A model may think out loud in a text block before calling the tool.
    // Concatenating that would hand parseAnswerText "Let me check…{claims"
    // — valid-looking output that fails the contract for a reason nobody
    // could diagnose from the error.
    const text = (t: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })
    const { baseUrl } = await boot((_, res) =>
      events(res, [
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        text("Let me check the docs. "),
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "emit_answer" } },
        json('{"claims":[]}'),
        { type: "content_block_stop", index: 1 },
        messageDelta("tool_use"), messageStop,
      ]),
    )
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl })
    const { text: answer } = await collect(provider.stream(request))
    expect(answer).toBe('{"claims":[]}')
  })

  it("maps a max_tokens cutoff to length", async () => {
    const { baseUrl } = await boot((_, res) =>
      events(res, [start, toolStart, json('{"claims":'), messageDelta("max_tokens"), messageStop]),
    )
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl })
    const { done } = await collect(provider.stream(request))
    expect(done!.finishReason).toBe("length")
  })

  it("throws a mid-stream error with the status its type means, so the retry policy can act", async () => {
    // The case this provider has and the others do not: a 200 that turns
    // into a failure. postStream never sees it, so the classification has
    // to happen here — 529 overloaded is worth retrying, 401 never is.
    const { baseUrl } = await boot((_, res) =>
      events(res, [
        start, toolStart, json('{"cla'),
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
    )
    const provider = new AnthropicProvider({ apiKey: "sk-ant-SECRET", baseUrl })
    const failure = await collect(provider.stream(request)).then(() => null, (e: unknown) => e)
    expect(failure).toBeInstanceOf(LLMHttpError)
    const error = failure as LLMHttpError
    expect(error.status).toBe(529)
    expect(error.message).toContain("overloaded_error")
    expect(error.message).toContain("mid-stream")
    expect(error.message).not.toContain("sk-ant-SECRET")
  })

  it("classifies a mid-stream auth failure as 401 — a wait cannot fix a wrong key", async () => {
    const { baseUrl } = await boot((_, res) =>
      events(res, [start, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }]),
    )
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl })
    const failure = await collect(provider.stream(request)).then(() => null, (e: unknown) => e)
    expect((failure as LLMHttpError).status).toBe(401)
  })

  it("reports usage as null when the stream never states it", async () => {
    // Null means "not reported" and 0 would mean "a model ran and consumed
    // nothing" — the distinction the cost metric is built on (§2.4.8).
    const { baseUrl } = await boot((_, res) =>
      events(res, [{ type: "message_start", message: {} }, toolStart, json("{}"), blockStop, messageStop]),
    )
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl })
    const { done } = await collect(provider.stream(request))
    expect(done!.usage).toBeNull()
  })

  it("throws LLMHttpError with the retry delay and no credentials on 429", async () => {
    const { baseUrl } = await boot((_, res) => {
      res.writeHead(429, { "retry-after": "12" })
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }))
    })
    const provider = new AnthropicProvider({ apiKey: "sk-ant-SECRET", baseUrl })
    const failure = await collect(provider.stream(request)).then(() => null, (e: unknown) => e)
    const error = failure as LLMHttpError
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(12_000)
    expect(error.message).not.toContain("sk-ant-SECRET")
  })
})
