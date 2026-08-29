// Scratch isolation probe (M9): resolve the org's embedder from the VAULT
// exactly as the ingest worker does, then embed one small batch and print
// the FULL error on failure. Exists because postStream truncates a provider
// body at 300 chars - which lands one character before Gemini's quotaId,
// the single fact that distinguishes a per-minute window from a spent day.
async function main(): Promise<void> {
  const { db } = await import("@/db/pool")
  const { resolveEmbeddingProvider } = await import("@/credentials/resolve")

  const ORG = "org_zqgayj3hwt2nfcrd3twmg0n5qwy7kyb1"
  try {
    const embedder = await resolveEmbeddingProvider(db, ORG)
    if (embedder === null) throw new Error("no embedding credential resolved for the demo org")
    console.log(`resolved: model=${embedder.model} dim=${embedder.dim}`)

    const texts = Array.from(
      { length: 8 },
      (_, i) =>
        `Fastify plugins and encapsulation, section ${i}. ` +
        "The framework provides a powerful plugin architecture with encapsulation contexts. ".repeat(
          6,
        ),
    )
    const started = Date.now()
    const vectors = await embedder.embed(texts, { task: "document" })
    console.log(
      `OK: ${vectors.length} vectors of ${vectors[0]?.length}-d in ${Date.now() - started}ms`,
    )
  } catch (error) {
    console.log("FAILED — full error:")
    console.log(error instanceof Error ? error.message : String(error))
  } finally {
    await db.destroy()
  }
}

void main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})

export {}
