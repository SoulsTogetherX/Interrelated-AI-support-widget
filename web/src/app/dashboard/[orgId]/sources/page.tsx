// Sources: connect documentation, watch it become retrievable. The list
// auto-refreshes ONLY while a job is moving (AutoRefresh mounts
// conditionally), so an idle page is a static snapshot. Since M7.5 each
// source also says what its last crawl did NOT take and why — robots.txt
// rules, dead links — and an owner can crawl it again from here. Since
// M7.6b a source can also be a FILE the tenant uploads, which is the same
// row with a filename where a URL would be.
import Link from "next/link"

import AddSourceForm from "@/components/AddSourceForm"
import AutoRefresh from "@/components/AutoRefresh"
import UploadSourceForm from "@/components/UploadSourceForm"
import { requireOrgMember } from "@/lib/orgs"
import { deleteSourceAction, recrawlSourceAction } from "@/lib/sources/actions"
import { hasActiveJob, listSourcesWithProgress } from "@/lib/sources/queries"
import { planFor } from "@shared/billing/plans"
import "./page.css"

import type { SourceWithProgress } from "@/lib/sources/queries"

export const metadata = { title: "Sources — Interrelated" }

function jobLabel(source: SourceWithProgress): string {
  const job = source.job
  if (!job) return source.kind === "upload" ? "not indexed" : "never crawled"
  // "· N skipped" rides along wherever there is a count to show: while the
  // crawl runs (the number grows with the progress) and once it is done.
  const skipped = job.skippedCount > 0 ? ` · ${job.skippedCount} skipped` : ""
  switch (job.state) {
    case "queued":
      return "queued…"
    case "running":
      // A file is not crawled, it is re-read from the text we kept — and
      // "crawling — 1/1 pages" about a document the tenant handed over reads
      // as the product doing something it explicitly promises not to do.
      if (source.kind === "upload") return `indexing…${skipped}`
      return job.docsTotal !== null
        ? `crawling — ${job.docsDone ?? 0}/${job.docsTotal} pages${skipped}`
        : `crawling — ${job.docsDone ?? 0} pages${skipped}`
    case "done":
      // An upload is always one document, and "1 pages indexed" about a file
      // the tenant just handed over reads as a crawl that went nowhere.
      if (source.kind === "upload") return `indexed${skipped}`
      return `${source.documentCount} pages indexed${skipped}`
    case "failed":
      return `failed: ${job.error ?? "unknown error"}`
  }
}

/** A source can be ingested again unless a job is already queued or running.
 *  Uploads included since M7.6b: migration 009 keeps the extracted text, so
 *  an upload whose first ingest failed — a wrong embedding credential, a
 *  provider outage — has something to retry FROM. Before that, its only
 *  recourse was to upload the file a second time. */
function canRecrawl(source: SourceWithProgress): boolean {
  const state = source.job?.state
  return state !== "queued" && state !== "running"
}

/** Bytes as a tenant would write them — binary units, matching the cap. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default async function SourcesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const sources = await listSourcesWithProgress(org.id)
  const isOwner = org.role === "owner"
  // The plan's source ceiling (M8.5) — the same number realtime enforces at
  // both create routes, read from the same catalog, so this page can never
  // promise room the route will refuse. Every row counts, failed ones
  // included: they hold a slot, which is what Delete releases.
  const plan = planFor(org.plan)
  const atLimit = sources.length >= plan.sources

  return (
    <div className="sources">
      {hasActiveJob(sources) ? <AutoRefresh /> : null}
      <nav className="sources-crumbs">
        <Link href={`/dashboard/${org.id}`}>{org.name}</Link> / Sources
      </nav>
      <h1 className="sources-title">Documentation sources</h1>
      <p className="sources-intro">
        Point Interrelated at your documentation. Crawling stays on your site&apos;s public pages
        (same-origin, private addresses refused), honors the site&apos;s <code>robots.txt</code>,
        re-crawls skip unchanged pages, and every indexed page becomes citable by the widget. Pages
        a crawl left out are listed under it with the reason.
      </p>

      <p className="sources-quota">
        {sources.length} of {plan.sources} {plan.sources === 1 ? "source" : "sources"} on the{" "}
        {plan.name} plan
        {atLimit
          ? " — the plan is full. Delete a source below or upgrade to connect another."
          : "."}
      </p>

      {isOwner ? (
        <section className="sources-card">
          <AddSourceForm orgId={org.id} />
        </section>
      ) : null}

      {isOwner ? (
        <section className="sources-card">
          <h2 className="sources-subtitle">Or upload a file</h2>
          <p className="sources-note">
            PDF, Markdown, HTML or plain text, up to 10 MB — for the handbook or policy that is not
            on a public page. The file is read when you upload it and is <strong>not stored</strong>
            : what we keep is the text extracted from it, which is what gets indexed and cited. A
            scanned PDF has no text to extract and is refused rather than indexed as an empty
            document.
          </p>
          <UploadSourceForm orgId={org.id} />
        </section>
      ) : null}

      <section className="sources-card">
        {sources.length === 0 ? (
          <p className="sources-empty">No sources yet{isOwner ? " — connect one above" : ""}.</p>
        ) : (
          <ul className="sources-list">
            {/* eslint-disable-next-line complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches */}
            {sources.map((s) => {
              const skipped = s.job?.skippedPages ?? []
              const skippedCount = s.job?.skippedCount ?? 0
              return (
                <li className="sources-item" key={s.id}>
                  <div className="sources-itemrow">
                    <div className="sources-itemmain">
                      <span className="sources-location">{s.location}</span>
                      <span className="sources-kind">
                        {s.kind === "upload" && s.upload
                          ? `${s.upload.format} · ${formatSize(s.upload.byteSize)}`
                          : s.kind}
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
                            {s.kind === "upload" ? "Re-index" : "Re-crawl"}
                          </button>
                        </form>
                      ) : null}
                      {/* Delete frees the source's slot against the plan's
                          ceiling (M8.5). Hidden while a crawl is RUNNING —
                          realtime refuses that delete (409) and a button
                          that always refuses is worse than none; a QUEUED
                          job dies with its source, so queued rows keep it.
                          No confirmation step, the house rule: the content
                          is re-creatable (a crawl by re-adding the URL, an
                          upload by re-uploading the file), and transcripts
                          that cited it keep their verdicts by design. */}
                      {isOwner && s.job?.state !== "running" ? (
                        <form action={deleteSourceAction}>
                          <input type="hidden" name="orgId" value={org.id} />
                          <input type="hidden" name="sourceId" value={s.id} />
                          <button className="sources-delete" type="submit">
                            Delete
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                  {skippedCount > 0 ? (
                    <details className="sources-skipped">
                      <summary>
                        {skippedCount === 1 ? "1 page skipped" : `${skippedCount} pages skipped`} —
                        why
                      </summary>
                      <ul className="sources-skipped-list">
                        {skipped.map((p) => (
                          <li key={p.url}>
                            <span className="sources-skipped-url">{p.url}</span> — {p.reason}
                          </li>
                        ))}
                        {skippedCount > skipped.length ? (
                          <li className="sources-skipped-more">
                            …and {skippedCount - skipped.length} more not listed (the first{" "}
                            {skipped.length} are kept).
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
