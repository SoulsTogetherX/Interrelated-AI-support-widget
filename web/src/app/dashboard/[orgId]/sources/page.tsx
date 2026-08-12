// Sources: connect documentation, watch it become retrievable. The list
// auto-refreshes ONLY while a job is moving (AutoRefresh mounts
// conditionally), so an idle page is a static snapshot.
import Link from "next/link"

import AddSourceForm from "@/components/AddSourceForm"
import AutoRefresh from "@/components/AutoRefresh"
import { requireOrgMember } from "@/lib/orgs"
import { hasActiveJob, listSourcesWithProgress } from "@/lib/sources/queries"
import "./page.css"

import type { SourceWithProgress } from "@/lib/sources/queries"

export const metadata = { title: "Sources — Interrelated" }

function jobLabel(source: SourceWithProgress): string {
  const job = source.job
  if (!job) return "never crawled"
  switch (job.state) {
    case "queued":
      return "queued…"
    case "running":
      return job.docsTotal !== null
        ? `crawling — ${job.docsDone ?? 0}/${job.docsTotal} pages`
        : `crawling — ${job.docsDone ?? 0} pages`
    case "done":
      return `${source.documentCount} pages indexed`
    case "failed":
      return `failed: ${job.error ?? "unknown error"}`
  }
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
        re-crawls skip unchanged pages, and every indexed page becomes
        citable by the widget.
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
            {sources.map((s) => (
              <li className="sources-item" key={s.id}>
                <div className="sources-itemmain">
                  <span className="sources-location">{s.location}</span>
                  <span className="sources-kind">
                    {s.kind}
                    {s.kind === "url" ? ` · depth ${s.crawlDepth}` : ""}
                  </span>
                </div>
                <span className={`sources-state sources-state-${s.job?.state ?? "none"}`}>
                  {jobLabel(s)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
