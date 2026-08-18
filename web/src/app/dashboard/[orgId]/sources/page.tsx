// Sources: connect documentation, watch it become retrievable. The list
// auto-refreshes ONLY while a job is moving (AutoRefresh mounts
// conditionally), so an idle page is a static snapshot. Since M7.5 each
// source also says what its last crawl did NOT take and why — robots.txt
// rules, dead links — and an owner can crawl it again from here.
import Link from "next/link"

import AddSourceForm from "@/components/AddSourceForm"
import AutoRefresh from "@/components/AutoRefresh"
import { requireOrgMember } from "@/lib/orgs"
import { recrawlSourceAction } from "@/lib/sources/actions"
import { hasActiveJob, listSourcesWithProgress } from "@/lib/sources/queries"
import "./page.css"

import type { SourceWithProgress } from "@/lib/sources/queries"

export const metadata = { title: "Sources — Interrelated" }

function jobLabel(source: SourceWithProgress): string {
  const job = source.job
  if (!job) return "never crawled"
  // "· N skipped" rides along wherever there is a count to show: while the
  // crawl runs (the number grows with the progress) and once it is done.
  const skipped = job.skippedCount > 0 ? ` · ${job.skippedCount} skipped` : ""
  switch (job.state) {
    case "queued":
      return "queued…"
    case "running":
      return job.docsTotal !== null
        ? `crawling — ${job.docsDone ?? 0}/${job.docsTotal} pages${skipped}`
        : `crawling — ${job.docsDone ?? 0} pages${skipped}`
    case "done":
      return `${source.documentCount} pages indexed${skipped}`
    case "failed":
      return `failed: ${job.error ?? "unknown error"}`
  }
}

/** A crawl can be queued again unless one is already queued or running,
 *  and never for an upload (the worker does not crawl those). */
function canRecrawl(source: SourceWithProgress): boolean {
  if (source.kind === "upload") return false
  const state = source.job?.state
  return state !== "queued" && state !== "running"
}

export default async function SourcesPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const sources = await listSourcesWithProgress(org.id)
  const isOwner = org.role === "owner"

  return (
    <div className="sources">
      {hasActiveJob(sources) ? <AutoRefresh /> : null}
      <nav className="sources-crumbs">
        <Link href={`/dashboard/${org.id}`}>{org.name}</Link> / Sources
      </nav>
      <h1 className="sources-title">Documentation sources</h1>
      <p className="sources-intro">
        Point Interrelated at your documentation. Crawling stays on your
        site&apos;s public pages (same-origin, private addresses refused),
        honors the site&apos;s <code>robots.txt</code>, re-crawls skip
        unchanged pages, and every indexed page becomes citable by the
        widget. Pages a crawl left out are listed under it with the reason.
      </p>

      {isOwner ? (
        <section className="sources-card">
          <AddSourceForm orgId={org.id} />
        </section>
      ) : null}

      <section className="sources-card">
        {sources.length === 0 ? (
          <p className="sources-empty">
            No sources yet{isOwner ? " — connect one above" : ""}.
          </p>
        ) : (
          <ul className="sources-list">
            {sources.map((s) => {
              const skipped = s.job?.skippedPages ?? []
              const skippedCount = s.job?.skippedCount ?? 0
              return (
                <li className="sources-item" key={s.id}>
                  <div className="sources-itemrow">
                    <div className="sources-itemmain">
                      <span className="sources-location">{s.location}</span>
                      <span className="sources-kind">
                        {s.kind}
                        {s.kind === "url" ? ` · depth ${s.crawlDepth}` : ""}
                      </span>
                    </div>
                    <div className="sources-itemside">
                      <span className={`sources-state sources-state-${s.job?.state ?? "none"}`}>
                        {jobLabel(s)}
                      </span>
                      {isOwner && canRecrawl(s) ? (
                        <form action={recrawlSourceAction}>
                          <input type="hidden" name="orgId" value={org.id} />
                          <input type="hidden" name="sourceId" value={s.id} />
                          <button className="sources-recrawl" type="submit">
                            Re-crawl
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                  {skippedCount > 0 ? (
                    <details className="sources-skipped">
                      <summary>
                        {skippedCount === 1 ? "1 page skipped" : `${skippedCount} pages skipped`} — why
                      </summary>
                      <ul className="sources-skipped-list">
                        {skipped.map((p) => (
                          <li key={p.url}>
                            <span className="sources-skipped-url">{p.url}</span> — {p.reason}
                          </li>
                        ))}
                        {skippedCount > skipped.length ? (
                          <li className="sources-skipped-more">
                            …and {skippedCount - skipped.length} more not listed (the first {skipped.length} are kept).
                          </li>
                        ) : null}
                      </ul>
                    </details>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
