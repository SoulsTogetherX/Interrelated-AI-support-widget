//#region Imports
import { OpenAICompatibleProvider } from "./openaiCompatible"
//#endregion

//#region Constants
const GROQ_BASE_URL = "https://api.groq.com/openai/v1"
/** Llama 3.3 70B: the free tier's strongest generalist and the demo org's
 *  default. Orgs override per-credential in M3. */
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile"
//#endregion

//#region Provider
/**
 * Groq — a named preset of the OpenAI-compatible adapter rather than its
 * own protocol implementation, because Groq's API IS OpenAI-compatible and
 * duplicating the stream loop would be two copies to fix. What the preset
 * pins: the base URL, the default model, json_object mode (Groq's JSON
 * mode is real but schema enforcement is not guaranteed across its model
 * catalog — the pipeline's validate-and-retry covers the gap), and the
 * error label. Groq's one wire quirk — usage arriving under x_groq on the
 * final chunk — is handled in the base adapter, since other compat servers
 * mirror it. A class (not a factory) so a Groq-specific quirk has an
 * obvious home when one appears.
 */
class GroqProvider extends OpenAICompatibleProvider {
  constructor(options: { apiKey: string; model?: string }) {
    super({
      provider: "groq",
      baseUrl: GROQ_BASE_URL,
      apiKey: options.apiKey,
      model: options.model ?? GROQ_DEFAULT_MODEL,
      jsonMode: "json_object",
    })
  }
}
//#endregion

//#region Exports
export { GroqProvider, GROQ_DEFAULT_MODEL }
//#endregion
