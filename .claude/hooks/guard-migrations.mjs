// PreToolUse guard: applied migrations are FROZEN (reference: the db
// migrations doctrine - additive only, never rewrite). An instruction is a
// request; this hook is enforcement. New migration files are allowed
// (append-only is the point); editing an EXISTING one is blocked.
import { readFileSync, existsSync } from "node:fs"

const input = JSON.parse(readFileSync(0, "utf8"))
const fp = String(input?.tool_input?.file_path ?? "").replaceAll("\\", "/")
if (/realtime\/src\/db\/migrations\/[^/]+\.ts$/.test(fp) && existsSync(fp)) {
  console.error(
    "BLOCKED: " +
      fp +
      " is an APPLIED migration - migrations are append-only " +
      "(deployed databases already ran it; editing it desyncs every one of them). " +
      "Add a new NNN_*.ts migration instead, register it in migrate.ts, and " +
      "update shared/db/schema.ts in the same change.",
  )
  process.exit(2)
}
process.exit(0)
