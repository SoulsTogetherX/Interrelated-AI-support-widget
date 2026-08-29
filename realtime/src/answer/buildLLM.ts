//#region Imports
import { MockLLMProvider } from "@providers/llm/mock"
import { GroqProvider } from "@providers/llm/groq"
import { GeminiProvider } from "@providers/llm/gemini"
import { OllamaProvider } from "@providers/llm/ollama"
import { AnthropicProvider } from "@providers/llm/anthropic"
import type { LLMProvider } from "@providers/llm/types"

import { groundedMockResponder } from "@/answer/mockResponder"
//#endregion

//#region Builder
/**
 * Name → configured LLMProvider, shared by server boot (LLM_PROVIDER env)
 * and the askDev CLI (--llm flag) so the selection table exists once.
 * Config comes from the env vars documented in .env.example; a missing
 * key throws a one-line usage error, not a stack trace from deep inside a
 * fetch.
 *
 * "mock" is the deliberate default everywhere: the responder-mode mock
 * answers by quoting the retrieved context, so compose stacks and CI
 * drive the REAL chat route end to end with zero API keys. This whole
 * builder is server-level configuration that M3 replaces with per-org
 * encrypted credentials — env-configured providers never ship to real
 * tenants.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function buildLLMProvider(name: string): LLMProvider {
  switch (name) {
    case "mock":
      return new MockLLMProvider(groundedMockResponder())
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY
      if (!apiKey) throw new Error("LLM provider groq needs GROQ_API_KEY (see .env.example)")
      return new GroqProvider({
        apiKey,
        ...(process.env.GROQ_MODEL ? { model: process.env.GROQ_MODEL } : {}),
      })
    }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY
      if (!apiKey) throw new Error("LLM provider gemini needs GEMINI_API_KEY (see .env.example)")
      return new GeminiProvider({
        apiKey,
        ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}),
      })
    }
    case "ollama": {
      const model = process.env.OLLAMA_MODEL
      if (!model) throw new Error("LLM provider ollama needs OLLAMA_MODEL (see .env.example)")
      return new OllamaProvider({
        model,
        ...(process.env.OLLAMA_BASE_URL ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
      })
    }
    case "anthropic": {
      // The one provider here with no free tier, so it is never a default
      // and never reached by CI, the demo, or any keyless stack — the
      // plan's "$0" constraint holds by nobody selecting it. It is
      // selectable for the same reason it is a credential option: a tenant
      // (or a developer comparing providers) may already pay for it.
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey)
        throw new Error("LLM provider anthropic needs ANTHROPIC_API_KEY (see .env.example)")
      return new AnthropicProvider({
        apiKey,
        ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
      })
    }
    default:
      throw new Error(`unknown LLM provider "${name}" (mock | groq | gemini | ollama | anthropic)`)
  }
}
//#endregion

//#region Exports
export { buildLLMProvider }
//#endregion
