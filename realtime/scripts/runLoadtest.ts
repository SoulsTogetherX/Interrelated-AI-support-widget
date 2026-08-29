//#region Why this file
// The handoff load harness's runner (M4.7) — `npm run loadtest`. Lives in
// realtime/ for the reason runEval.ts does: it drives realtime's code and
// needs its dependencies (pg, the ticket signer), while the harness itself
// (loadtest/) stays a package-less, dependency-free module the root runner
// typechecks and unit-tests.
//
// It seeds its own fixtures directly in Postgres — org, conversations,
// handoffs — and mints tickets with the SAME signer the server verifies
// with, rather than driving /v1/widget/session and /v1/widget/escalate.
// That is deliberate: those routes are rate-limited per IP (§3.17.2), so a
// thousand sessions from one machine would measure the token bucket doing
// its job, not the socket. The HTTP surface has its own tests; this
// measures what the plan asked to measure — the socket under concurrency.
//
// Everything it creates is deleted at the end, including on Ctrl-C.
//#endregion

//#region Imports
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { formatSummary } from "@loadtest/histogram"
import { runHandoffLoad } from "@loadtest/handoffLoad"
import type { SessionTickets } from "@loadtest/handoffLoad"
//#endregion

//#region Env fallback
// The same block the sibling CLIs carry (§3.11), with one addition: this
// runner also needs WIDGET_TOKEN_SECRET, because it signs tickets the
// server will verify. Env already set always wins.
//
// It must run BEFORE @/db/pool loads — the pool reads env at module load —
// which is why main() defers every import that touches it.
if (!process.env.POSTGRES_PASSWORD || !process.env.WIDGET_TOKEN_SECRET) {
  try {
    const envFile = readFileSync(resolve(__dirname, "../../.env"), "utf8")
    for (const line of envFile.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2]
      }
    }
  } catch {
    // No .env — the checks below say exactly what is missing.
  }
}
//#endregion

//#region CLI
interface Options {
  sessions: number
  messages: number
  intervalMs: number
  drainMs: number
  base: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sessions: 25,
    messages: 10,
    intervalMs: 250,
    drainMs: 2_000,
    base: process.env.LOADTEST_BASE_URL ?? "http://localhost:3000",
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    const num = (): number => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0)
        throw new Error(`${flag} needs a positive number`)
      i++
      return parsed
    }
    if (flag === "--sessions") options.sessions = num()
    else if (flag === "--messages") options.messages = num()
    else if (flag === "--interval") options.intervalMs = num()
    else if (flag === "--drain") options.drainMs = num()
    else if (flag === "--base" && value !== undefined) {
      options.base = value
      i++
    } else if (flag === "--help") {
      console.log(
        "usage: npm run loadtest -- [--sessions 25] [--messages 10] [--interval 250]\n" +
          "                          [--drain 2000] [--base http://localhost:3000]\n\n" +
          "One session is one conversation: a visitor socket AND an agent socket.\n" +
          "Requires a running realtime service started with the SAME\n" +
          "WIDGET_TOKEN_SECRET this process reads (tickets are signed with a key\n" +
          "derived from it), and POSTGRES_* pointing at that service's database.",
      )
      process.exit(0)
    }
  }
  return options
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  const secret = process.env.WIDGET_TOKEN_SECRET
  if (!secret || secret.length < 32) {
    console.error(
      "loadtest: WIDGET_TOKEN_SECRET must be set (≥32 chars) and must MATCH the\n" +
        "running service — tickets are signed with a key derived from it, and an\n" +
        "ephemeral server secret (the dev default when unset) would refuse every\n" +
        "upgrade. Set it in .env and start realtime with it.",
    )
    process.exit(1)
  }

  const { db } = await import("@/db/pool")
  const { newId } = await import("@shared/utils/ids")
  const { mintHandoffTicket } = await import("@/handoff/ticket")

  const orgId = newId("org")
  const agentId = newId("usr")
  const wsBase = options.base.replace(/^http/, "ws").replace(/\/$/, "")

  const cleanup = async (): Promise<void> => {
    // One delete: organizations cascades to conversations, handoffs, and
    // messages, so a run leaves the database exactly as it found it.
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await db.deleteFrom("users").where("id", "=", agentId).execute()
  }
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130))
  })

  try {
    console.log(
      `loadtest: ${options.sessions} sessions × ${options.messages} messages per side ` +
        `every ${options.intervalMs}ms → ${wsBase}`,
    )

    // ── Seed ───────────────────────────────────────────────────────────────
    await db.insertInto("organizations").values({ id: orgId, name: "Loadtest Org" }).execute()
    await db
      .insertInto("users")
      .values({
        id: agentId,
        email_index: `idx_${agentId}`,
        email_ciphertext: "v1.loadtest",
        password_hash: "scrypt$loadtest",
      })
      .execute()
    await db
      .insertInto("org_members")
      .values({ org_id: orgId, user_id: agentId, role: "agent" })
      .execute()

    const sessions: SessionTickets[] = []
    const conversations = Array.from({ length: options.sessions }, (_, i) => ({
      id: newId("con"),
      org_id: orgId,
      visitor_id: `vis_load_${i}`,
    }))
    await db.insertInto("conversations").values(conversations).execute()
    await db
      .insertInto("handoff_sessions")
      .values(
        conversations.map((conversation) => ({
          id: newId("hnd"),
          org_id: orgId,
          conversation_id: conversation.id,
          reason: "visitor_request" as const,
        })),
      )
      .execute()

    for (const conversation of conversations) {
      sessions.push({
        conversationId: conversation.id,
        visitorTicket: mintHandoffTicket(
          { con: conversation.id, org: orgId, role: "visitor", sub: conversation.visitor_id },
          secret,
        ).ticket,
        agentTicket: mintHandoffTicket(
          { con: conversation.id, org: orgId, role: "agent", sub: agentId },
          secret,
        ).ticket,
      })
    }
    console.log(`seeded ${sessions.length} escalated conversations under ${orgId}`)

    // ── Run ────────────────────────────────────────────────────────────────
    const result = await runHandoffLoad({
      wsBase,
      sessions,
      messagesPerSide: options.messages,
      intervalMs: options.intervalMs,
      drainMs: options.drainMs,
      log: (line) => console.log(line),
    })

    // ── Report ─────────────────────────────────────────────────────────────
    const totalMessages = result.echoed
    const seconds = result.elapsedMs / 1000
    console.log("")
    console.log(`concurrent sockets sustained : ${result.connected}`)
    console.log(
      `messages persisted+broadcast : ${totalMessages} in ${seconds.toFixed(1)}s ` +
        `(${(totalMessages / seconds).toFixed(0)}/s)`,
    )
    // "unfinished", not "dropped": past the knee these are messages still in
    // the queue when the drain window expired — the sockets were open and no
    // error was raised, so calling them lost would overstate what happened.
    console.log(
      `unfinished at drain / send errors / socket errors: ` +
        `${result.lost} / ${result.sendErrors} / ${result.socketErrors}`,
    )
    console.log("")
    console.log(formatSummary("connect (ready+history)", result.connect.summary()))
    console.log(formatSummary("round trip (own echo)", result.roundTrip.summary()))
    console.log(formatSummary("delivery (other side)", result.delivery.summary()))
    console.log("")
    console.log("all latencies in ms; round trip includes the Postgres write,")
    console.log("because the server persists before it broadcasts (CLAUDE.md §3.25).")

    if (result.lost > 0 || result.socketErrors > 0) {
      // A load run that dropped messages is a result, not a crash — but it
      // must not read as success to a script.
      process.exitCode = 1
    }
  } finally {
    await cleanup()
    await db.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
//#endregion
