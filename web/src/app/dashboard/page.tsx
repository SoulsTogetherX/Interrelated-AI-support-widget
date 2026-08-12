// The /dashboard router: with no org yet this IS onboarding (the create
// form, front and center — one decision); with orgs it forwards to the
// first one, which keeps "/dashboard" a stable bookmark while org-scoped
// pages live at /dashboard/[orgId].
import { redirect } from "next/navigation"

import CreateOrgForm from "@/components/CreateOrgForm"
import { requireUser } from "@/lib/auth/requireUser"
import { listOrgsForUser } from "@/lib/orgs"
import "./page.css"

export const metadata = { title: "Dashboard — Interrelated" }

export default async function DashboardPage() {
  const user = await requireUser()
  const orgs = await listOrgsForUser(user.id)
  if (orgs.length > 0) {
    redirect(`/dashboard/${orgs[0].id}`)
  }
  return (
    <div className="dashboard-onboarding">
      <CreateOrgForm title="Create your organization" />
    </div>
  )
}
