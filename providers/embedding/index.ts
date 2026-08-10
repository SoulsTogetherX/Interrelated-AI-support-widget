//#region Exports
// The embedding provider surface. Consumers import from here, not from the
// implementation files, so adding a provider is one line in one place.
export type { EmbeddingProvider } from "./types"
export { MockEmbeddingProvider } from "./mock"
export { LocalEmbeddingProvider } from "./local"
//#endregion
