// The authenticated shell — currently the landing spot that proves the
// session round-trip. Org onboarding (M3.3) replaces the placeholder body;
// the requireUser() opening line is the pattern every authenticated page
// repeats (see lib/auth/requireUser.ts for why there is no middleware).
import { logoutAction } from "@/lib/auth/actions"
import { requireUser } from "@/lib/auth/requireUser"
import "./page.css"

export const metadata = { title: "Dashboard — Interrelated" }

export default async function DashboardPage() {
  const user = await requireUser()
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <span className="dashboard-brand">Interrelated</span>
        <div className="dashboard-session">
          <span className="dashboard-email">{user.email}</span>
          <form action={logoutAction}>
            <button className="dashboard-signout" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="dashboard-body">
        <h1 className="dashboard-title">Welcome</h1>
        <p className="dashboard-status">
          You are signed in. Organization onboarding — creating your org,
          connecting an AI provider, and getting your widget snippet — is the
          next increment (M3.3).
        </p>
      </main>
    </div>
  )
}
