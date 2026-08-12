//#region Imports
import type { EmbeddingProvider } from "./types"
//#endregion

//#region Provider
/**
 * Local embeddings via fastembed (ONNX bge-small-en-v1.5, 384-d) — the
 * keyless, offline implementation the eval harness and CI use so retrieval
 * quality is measurable with no API key and no network flake.
 *
 * The fastembed dependency is loaded with a DYNAMIC import, not a static
 * one. providers/ has no package.json (it compiles inside each consumer via
 * the @providers alias), so it cannot declare dependencies — instead, the
 * package that actually runs this class declares fastembed (the repo root
 * does today, for its gated test; eval/ will in M1.3). Every other consumer
 * can import this FILE freely: the cost is only paid on first embed().
 *
 * Deliberately NOT used in the Render deployment: onnxruntime costs
 * ~250–400 MB of RAM, and the service runs in 512 MB. Production embedding
 * is remote (per-org BYO providers); local is for eval, CI, and offline dev.
 *
 * ~30 MB model download on first use, cached under local_cache/ by
 * fastembed. The gated test (FASTEMBED_TEST=1) exercises the real thing.
 *
 * The EmbedOptions task hint is ignored here, and that is a decision rather
 * than an omission: bge-small IS asymmetric (it ships a "Represent this
 * sentence for searching relevant passages:" query prefix), but every
 * number in eval/RESULTS.md — including the recall floor CI enforces and
 * the refusal threshold in answer/gate.ts — was measured with the symmetric
 * call. Turning the prefix on is a retrieval change that must land WITH a
 * re-run of the golden set and a re-baselined floor, not as a side effect
 * of the BYO-embedding increment.
 */
/** The slice of fastembed's API this provider touches. Declared locally (and
 *  structurally satisfied by the real module) so this file typechecks in
 *  consumers that never install fastembed. */
interface FastembedEngine {
  embed(texts: string[], batchSize?: number): AsyncIterable<ArrayLike<number>[]>
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model = "bge-small-en-v1.5"
  readonly dim = 384

  // The initialized fastembed engine, created once on first call.
  #engine: FastembedEngine | null = null

  async #init(): Promise<FastembedEngine> {
    if (this.#engine) return this.#engine
    let mod: typeof import("fastembed")
    try {
      mod = await import("fastembed")
    } catch {
      throw new Error(
        "fastembed is not installed in the running package — `npm i -D fastembed` there, or use a remote provider",
      )
    }
    const engine: FastembedEngine = await mod.FlagEmbedding.init({
      model: mod.EmbeddingModel.BGESmallENV15,
    })
    this.#engine = engine
    return engine
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const engine = await this.#init()
    const out: number[][] = []
    // fastembed yields batches; flatten while preserving input order.
    for await (const batch of engine.embed([...texts])) {
      for (const vector of batch) out.push(Array.from(vector))
    }
    if (out.length !== texts.length) {
      throw new Error(`fastembed returned ${out.length} vectors for ${texts.length} texts`)
    }
    return out
  }
}
//#endregion

//#region Exports
export { LocalEmbeddingProvider }
//#endregion
