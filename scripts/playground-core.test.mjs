//#region Imports
import { describe, expect, it } from "vitest"

import {
  parseDotenv,
  generateSecrets,
  reconcileSecrets,
  assembleEnv,
  parseSeedResult,
  buildBanner,
} from "./playground-core.mjs"
//#endregion

//#region Fixtures
/** Deterministic stand-in for node:crypto.randomBytes — a buffer of `fill`
 *  bytes, so shapes are assertable without stubbing crypto globally. */
const bytes = (fill) => (n) => Buffer.alloc(n, fill)

const SECRETS = {
  version: 1,
  createdAt: "2026-08-21T00:00:00.000Z",
  credentialMasterKey: Buffer.alloc(32, 1).toString("base64"),
  internalApiSecret: Buffer.alloc(32, 2).toString("base64url"),
  widgetTokenSecret: Buffer.alloc(32, 3).toString("base64url"),
}
//#endregion

describe("parseDotenv", () => {
  it("mirrors web/next.config.ts's loader: comments, blanks, first =, trim, verbatim values", () => {
    const parsed = parseDotenv([
      "# a comment",
      "",
      "POSTGRES_HOST=localhost",
      "  POSTGRES_PORT = 5433  ",
      "WEIRD=a=b=c",
      "EMPTY=",
      "no_equals_line",
      "QUOTED=\"kept-verbatim\"",
    ].join("\n"))
    expect(parsed).toEqual({
      POSTGRES_HOST: "localhost",
      POSTGRES_PORT: "5433",
      // Split on the FIRST = only — a base64 value with padding survives.
      WEIRD: "a=b=c",
      EMPTY: "",
      // No quote stripping: the root .env never quotes, and inventing
      // stripping here would make this parser disagree with next.config's.
      QUOTED: "\"kept-verbatim\"",
    })
  })

  it("survives CRLF input — the .gitattributes lesson", () => {
    // A CRLF .env once corrupted a Postgres password on a sibling project
    // (the password became "value\r"). trim() strips the \r here exactly as
    // next.config's loader does.
    const parsed = parseDotenv("POSTGRES_PASSWORD=hunter2\r\nPOSTGRES_DB=interrelated\r\n")
    expect(parsed.POSTGRES_PASSWORD).toBe("hunter2")
    expect(parsed.POSTGRES_DB).toBe("interrelated")
  })

  it("keeps the FIRST occurrence of a duplicated name, like the loader it mirrors", () => {
    expect(parseDotenv("A=first\nA=second").A).toBe("first")
  })
})

describe("generateSecrets / reconcileSecrets", () => {
  it("generates secrets in the shapes the services enforce", () => {
    const secrets = generateSecrets(bytes(7))
    // The vault requires EXACTLY 32 bytes of base64.
    expect(Buffer.from(secrets.credentialMasterKey, "base64")).toHaveLength(32)
    // server.ts refuses an internal secret under 32 chars; sessionToken.ts
    // refuses a short widget secret.
    expect(secrets.internalApiSecret.length).toBeGreaterThanOrEqual(32)
    expect(secrets.widgetTokenSecret.length).toBeGreaterThanOrEqual(32)
    expect(secrets.version).toBe(1)
  })

  it("regenerates whole on a missing or unparseable file", () => {
    expect(reconcileSecrets(null, bytes(7)).changed).toBe(true)
    expect(reconcileSecrets("not json{", bytes(7)).changed).toBe(true)
    expect(reconcileSecrets("\"a string\"", bytes(7)).changed).toBe(true)
  })

  it("fills only the MISSING fields of a partial file — the master key survives", () => {
    // The one field that must never silently regenerate: it encrypts tenant
    // provider keys at rest, and a fresh one orphans every saved credential.
    const partial = JSON.stringify({ credentialMasterKey: SECRETS.credentialMasterKey })
    const { secrets, changed } = reconcileSecrets(partial, bytes(9))
    expect(changed).toBe(true)
    expect(secrets.credentialMasterKey).toBe(SECRETS.credentialMasterKey)
    expect(secrets.internalApiSecret).toBe(Buffer.alloc(32, 9).toString("base64url"))
  })

  it("returns an intact file unchanged", () => {
    const { secrets, changed } = reconcileSecrets(JSON.stringify(SECRETS), bytes(9))
    expect(changed).toBe(false)
    expect(secrets).toEqual(SECRETS)
  })
})

describe("assembleEnv", () => {
  it("layers shell over .env over playground fills, and hard overrides over everything", () => {
    const { env, warnings } = assembleEnv({
      processEnv: { POSTGRES_HOST: "from-shell", EMBEDDING_PROVIDER: "mock" },
      dotenv: { POSTGRES_HOST: "from-dotenv", POSTGRES_PASSWORD: "pw", LLM_PROVIDER: "groq" },
      secrets: SECRETS,
    })
    // Shell beats .env.
    expect(env.POSTGRES_HOST).toBe("from-shell")
    // .env fills what the shell left unset.
    expect(env.POSTGRES_PASSWORD).toBe("pw")
    // A deliberate .env LLM_PROVIDER survives the mock fill.
    expect(env.LLM_PROVIDER).toBe("groq")
    // Hard overrides win even over the shell, with a warning naming it.
    expect(env.EMBEDDING_PROVIDER).toBe("local")
    expect(warnings.some((w) => w.includes("EMBEDDING_PROVIDER=mock overridden to local"))).toBe(true)
    expect(env.INGEST_WORKER).toBe("1")
    expect(env.BACKEND_PORT).toBe("3000")
    expect(env.FIXTURE_PORT).toBe("4400")
  })

  it("fills the secret trio only where unset, treating empty string as unset", () => {
    // .env.example ships WIDGET_TOKEN_SECRET= (empty). Empty means ephemeral
    // per boot for widget tokens and refused at boot for the internal pair —
    // neither is what a playground wants, so empty counts as absent.
    const { env } = assembleEnv({
      processEnv: {},
      dotenv: { WIDGET_TOKEN_SECRET: "" },
      secrets: SECRETS,
    })
    expect(env.WIDGET_TOKEN_SECRET).toBe(SECRETS.widgetTokenSecret)
    expect(env.INTERNAL_API_SECRET).toBe(SECRETS.internalApiSecret)
    expect(env.CREDENTIAL_MASTER_KEY).toBe(SECRETS.credentialMasterKey)
    expect(env.DEMO_PUBLISHABLE_KEY).toBe("pk_local_demo_widget_fixture_key0")
    expect(env.REALTIME_INTERNAL_URL).toBe("http://localhost:3000")
    expect(env.NEXT_PUBLIC_WIDGET_API_URL).toBe("http://localhost:3000")
    expect(env.LLM_PROVIDER).toBe("mock")
    expect(env.INGEST_POLL_MS).toBe("0")
  })

  it("respects a user-supplied master key but warns that old saved credentials cannot decrypt", () => {
    const userKey = Buffer.alloc(32, 5).toString("base64")
    const { env, warnings } = assembleEnv({
      processEnv: {},
      dotenv: { CREDENTIAL_MASTER_KEY: userKey },
      secrets: SECRETS,
    })
    expect(env.CREDENTIAL_MASTER_KEY).toBe(userKey)
    expect(warnings.some((w) => w.includes("differs from .playground/secrets.json"))).toBe(true)
  })

  it("stays quiet when nothing conflicts", () => {
    const { warnings } = assembleEnv({
      processEnv: {},
      dotenv: { POSTGRES_PASSWORD: "pw" },
      secrets: SECRETS,
    })
    expect(warnings).toEqual([])
  })
})

describe("parseSeedResult / buildBanner", () => {
  const RESULT = { email: "play@interrelated.local", role: "owner", passwordChanged: false, orgId: "org_x" }

  it("round-trips the machine line out of mixed human output, last occurrence winning", () => {
    const stdout = [
      "checking the demo org…",
      "PLAYGROUND_RESULT {\"stale\":true}",
      "user ready",
      `PLAYGROUND_RESULT ${JSON.stringify(RESULT)}`,
      "",
    ].join("\n")
    expect(parseSeedResult(stdout)).toEqual(RESULT)
  })

  it("answers null — never a throw — on absence or bad JSON", () => {
    expect(parseSeedResult("no machine line here")).toBeNull()
    expect(parseSeedResult("PLAYGROUND_RESULT {broken")).toBeNull()
  })

  it("banner states credentials, the mock explanation, and the stop instruction", () => {
    const banner = buildBanner({ seed: RESULT, llmProvider: "mock", skippedSeed: false })
    expect(banner).toContain("play@interrelated.local / play-with-interrelated")
    expect(banner).toContain("(owner of the demo org)")
    expect(banner).toContain("http://localhost:4400/fixtures/tailwind.html")
    expect(banner).toContain("http://localhost:3001")
    expect(banner).toContain("http://localhost:3000/demo")
    expect(banner).toContain("deterministic mock")
    expect(banner).toContain("docker compose stop database")
  })

  it("banner adapts to a changed password and to a real provider", () => {
    const changed = buildBanner({
      seed: { ...RESULT, passwordChanged: true },
      llmProvider: "gemini",
      skippedSeed: false,
    })
    expect(changed).toContain("password you set previously")
    expect(changed).toContain("LLM_PROVIDER=gemini")
    expect(changed).not.toContain("play-with-interrelated")
  })
})
