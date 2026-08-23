//#region Exports
// The embedding provider surface. Consumers import from here, not from the
// implementation files, so adding a provider is one line in one place.
// (The remote adapters are the exception nothing enforces: realtime's
// credential layer constructs them by name from a stored row, so it imports
// the files directly — the same way it does for the generation side.)
export type { EmbeddingProvider, EmbedOptions, EmbedTask } from "./types"
export { DIM_UNKNOWN } from "./types"
export { MockEmbeddingProvider } from "./mock"
export { LocalEmbeddingProvider } from "./local"
export { GeminiEmbeddingProvider, GEMINI_EMBED_MODEL, GEMINI_EMBED_DIM } from "./gemini"
export { OpenAICompatibleEmbeddingProvider } from "./openaiCompatible"
export { OllamaEmbeddingProvider } from "./ollama"
//#endregion
