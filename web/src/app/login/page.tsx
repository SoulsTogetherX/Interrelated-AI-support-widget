// Sign-in. Checks for an existing session FIRST: a signed-in user landing
// here is redirected to the dashboard rather than shown a form whose
// success would just mint a second session. That check makes this page
// dynamic (it reads cookies), which is correct — a login page's content
// depends on who is asking.
import Link from "next/link"
import { redirect } from "next/navigation"

import AuthForm from "@/components/AuthForm"
import { loginAction } from "@/lib/auth/actions"
import { currentUser } from "@/lib/auth/requireUser"
import "./page.css"

export const metadata = { title: "Sign in — Interrelated" }

export default async function LoginPage() {
  if (await currentUser()) {
    redirect("/dashboard")
  }
  return (
    <main className="authpage">
      <AuthForm
        action={loginAction}
        title="Sign in"
        submitLabel="Sign in"
        passwordAutoComplete="current-password"
        footer={
          <>
            New to Interrelated? <Link href="/signup">Create an account</Link>
          </>
        }
      />
    </main>
  )
}
