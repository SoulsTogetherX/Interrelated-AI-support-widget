// Additional-org creation. A literal segment, which Next matches BEFORE the
// [orgId] dynamic sibling — and even if that precedence ever changed,
// "new" fails isId("org", …) and would 404 rather than resolve as an org.
import CreateOrgForm from "@/components/CreateOrgForm"
import { requireUser } from "@/lib/auth/requireUser"
import "../page.css"

export const metadata = { title: "New organization — Interrelated" }

export default async function NewOrgPage() {
  await requireUser()
  return (
    <div className="dashboard-onboarding">
      <CreateOrgForm title="Create another organization" />
    </div>
  )
}
