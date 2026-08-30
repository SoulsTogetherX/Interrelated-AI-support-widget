# Incident reports

Production-only failures, written up after the fact. Each one is a defect that
**no local test could have caught**, found by running the deployed system
against a real provider — which is the property that makes them worth the pages.

`docs/history.md` records what each milestone built and why. These records
answer a different question: what broke in production, how long it took to see
it, what was believed in the meantime, and what changed so the same class of
failure announces itself next time. The wrong diagnoses are kept deliberately —
a postmortem that lists only the correct explanation teaches nothing about how
the incident actually felt from inside it.

| Incident                                                                                 | Date       | Impact                                                                               |
| ---------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| [001 — A page that could never be ingested](001-metered-embedding-un-ingestable-page.md) | 2026-08-24 | The deployed demo's corpus could not finish re-embedding; large pages never ingested |
| [002 — Bimodal free-tier model latency](002-bimodal-model-latency.md)                    | 2026-08-25 | Answers 20x slower than expected, some hitting the 60 s deadline and failing         |

## Format

Timeline → impact → root cause → why local tests could not catch it →
detection gap → remediation. Every number in these documents is measured and
attributed to the commit or script that produced it; where something is
unproven it says so.
