// Root layout — the one place global CSS enters the app, and the owner of
// the <html>/<body> shell every route renders inside. Everything here is a
// Server Component by default; nothing in the shell needs client JS.
import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./globals.css"

export const metadata: Metadata = {
  title: "Interrelated",
  description:
    "Embeddable AI support that cites its sources — every answer verified against your docs before a visitor sees it.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
