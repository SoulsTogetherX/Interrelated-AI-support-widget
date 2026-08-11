//#region Imports
import { MockLLMProvider } from "@providers/llm/mock"
import { GroqProvider } from "@providers/llm/groq"
import { GeminiProvider } from "@providers/llm/gemini"
import { OllamaProvider } from "@providers/llm/ollama"
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
function buildLLMProvider(name: string): LLMProvider {
  switch (name) {
    case "mock":
      return new MockLLMProvider(groundedMockResponder())
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY
      if (!apiKey) throw new Error("LLM provider groq needs GROQ_API_KEY (see .env.example)")
      return new GroqProvider({ apiKey, ...(process.env.GROQ_MODEL ? { model: process.env.GROQ_MODEL } : {}) })
    }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY
      if (!apiKey) throw new Error("LLM provider gemini needs GEMINI_API_KEY (see .env.example)")
      return new GeminiProvider({ apiKey, ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}) })
    }
    case "ollama": {
      const model = process.env.OLLAMA_MODEL
      if (!model) throw new Error("LLM provider ollama needs OLLAMA_MODEL (see .env.example)")
      return new OllamaProvider({ model, ...(process.env.OLLAMA_BASE_URL ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}) })
    }
    default:
      throw new Error(`unknown LLM provider "${name}" (mock | groq | gemini | ollama)`)
  }
}
//#endregion

//#region Exports
export { buildLLMProvider }
//#endregion
