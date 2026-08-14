// The metrics page (M5.1) — the plan's "instrument from day one" bill, come
// due. Every number here was already being written by the pipeline; this is
// the first surface that adds them up.
//
// Two editorial decisions, both about honesty. Rates that have no
// denominator render as "—" rather than 0%, because a fresh org has no
// deflection rate and printing 0% would be a lie told during exactly the
// week someone is judging the product. And the strip rate — the share of
// model output the verifier refused to show a visitor — is given the same
// prominence as deflection, because a bot that deflects everything by
// answering confidently from nothing is the failure this project exists to
// prevent.
import { requireOrgMember } from "@/lib/orgs"
import { getOrgMetrics } from "@/lib/metrics/queries"
import "./page.css"

export const metadata = { title: "Metrics — Interrelated" }

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`
}

function ms(value: number | null): string {
  if (value === null) return "—"
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="metrics-stat">
      <span className="metrics-stat-label">{label}</span>
      <strong className="metrics-stat-value">{value}</strong>
      <span className="metrics-stat-hint">{hint}</span>
    </div>
  )
}

export default async function MetricsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const metrics = await getOrgMetrics(org.id)
  const { answers, grounding, deflection, byModel } = metrics

  return (
    <div className="metrics">
      <h1 className="metrics-title">Metrics</h1>
      <p className="metrics-lede">
        The last {metrics.windowDays} days. Every number comes from what the answer pipeline
        already records per message — no sampling, no estimates.
      </p>

      <section className="metrics-section">
        <h2>Answering</h2>
        <div className="metrics-grid">
          <Stat
            label="Deflection rate"
            value={percent(deflection.deflectionRate)}
            hint={`${deflection.conversations - deflection.escalated} of ${deflection.conversations} answered conversations never reached a person`}
          />
          <Stat
            label="Refusal rate"
            value={percent(answers.refusalRate)}
            hint={`${answers.refusals} of ${answers.answers} answers declined for want of grounded evidence`}
          />
          <Stat
            label="Answers"
            value={String(answers.answers)}
            hint="assistant messages in the window"
          />
        </div>
        <p className="metrics-note">
          Deflection is counted per conversation, not per message: a long thread that ends in an
          escalation would otherwise contribute a dozen &ldquo;deflected&rdquo; answers. Read it
          beside the refusal rate — a bot that refuses everything also escalates nothing.
        </p>
      </section>

      <section className="metrics-section">
        <h2>Grounding</h2>
        <div className="metrics-grid">
          <Stat
            label="Claim strip rate"
            value={percent(grounding.stripRate)}
            hint={`${grounding.stripped} of ${grounding.claims} claims were withheld from visitors`}
          />
          <Stat
            label="Misquoted"
            value={String(grounding.quoteNotFound)}
            hint="claims whose quote was not found in the source they cited"
          />
          <Stat
            label="Fabricated source"
            value={String(grounding.unknownChunk)}
            hint="claims citing a chunk that was never retrieved"
          />
        </div>
        <p className="metrics-note">
          Every claim the model makes is checked against the text it cited, and the ones that fail
          are removed before the visitor sees them. This is that number — the share of model output
          this product declined to pass on.
        </p>
      </section>

      <section className="metrics-section">
        <h2>Latency</h2>
        <p className="metrics-note">
          Answered messages only. A refusal is decided before any model call, so it has no
          first-token time — mixing the two would compare percentiles over different rows.
        </p>
        <div className="metrics-grid">
          <Stat
            label="Time to first token (p50)"
            value={ms(answers.ttftP50Ms)}
            hint="measured in the pipeline at the first delta, so every provider is measured identically"
          />
          <Stat label="Time to first token (p95)" value={ms(answers.ttftP95Ms)} hint="the slow tail visitors feel" />
          <Stat label="Full answer (p50)" value={ms(answers.totalP50Ms)} hint={`p95 ${ms(answers.totalP95Ms)}`} />
        </div>
      </section>

      <section className="metrics-section">
        <h2>Handoff</h2>
        <div className="metrics-grid">
          <Stat
            label="Escalations"
            value={String(deflection.escalated)}
            hint={`${deflection.handoffsAnswered} answered by a person`}
          />
          <Stat
            label="First human response (p50)"
            value={ms(deflection.firstHumanResponseP50Ms)}
            hint="from the visitor asking to an agent's first message"
          />
          <Stat
            label="First human response (p95)"
            value={ms(deflection.firstHumanResponseP95Ms)}
            hint="measured to the reply, not to the agent opening the tab"
          />
        </div>
      </section>

      <section className="metrics-section">
        <h2>By model</h2>
        {byModel.length === 0 ? (
          <p className="metrics-empty">No answers yet — connect a provider and ask something.</p>
        ) : (
          <table className="metrics-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Answers</th>
                <th>Refused</th>
                <th>TTFT p50</th>
                <th>Total p50</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((row) => (
                <tr key={row.model}>
                  <td><code>{row.model}</code></td>
                  <td>{row.answers}</td>
                  <td>{percent(row.answers > 0 ? row.refusals / row.answers : null)}</td>
                  <td>{ms(row.ttftP50Ms)}</td>
                  <td>{ms(row.totalP50Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="metrics-note">
          Switching provider changes this table, not the schema: the model is recorded per answer,
          so a comparison is a query rather than a migration. Cost per 1,000 answers joins this
          table once per-provider pricing lands.
        </p>
      </section>
    </div>
  )
}
