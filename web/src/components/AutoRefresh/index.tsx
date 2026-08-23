"use client"

//#region Why this exists
// RSC pages are snapshots; ingest progress moves without user input. This
// tiny client component re-fetches the CURRENT route's server payload
// (router.refresh() — no navigation, no state loss) on an interval, and
// only mounts when the page decides something is actually moving (the
// sources page renders it only while a job is queued/running), so an idle
// dashboard costs zero requests. Polling over a socket/SSE on purpose:
// ingest progress changes on the seconds scale and a 4s poll against
// Vercel's own origin is cheaper than a realtime channel — the WebSocket
// budget is reserved for M4's handoff, where latency actually matters.
//#endregion

//#region Imports
import { useEffect } from "react"
import { useRouter } from "next/navigation"
//#endregion

//#region Component
export default function AutoRefresh({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs)
    return () => clearInterval(timer)
  }, [router, everyMs])
  return null
}
//#endregion
