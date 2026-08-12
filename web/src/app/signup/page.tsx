// Account creation. Same session-first redirect as /login (see that file's
// header comment for why).
import Link from "next/link"
import { redirect } from "next/navigation"

import AuthForm from "@/components/AuthForm"
import { signupAction } from "@/lib/auth/actions"
import { currentUser } from "@/lib/auth/requireUser"
import "../login/page.css"

export const metadata = { title: "Create an account — Interrelated" }

export default async function SignupPage() {
  if (await currentUser()) {
    redirect("/dashboard")
  }
  return (
    <main className="authpage">
      <AuthForm
        action={signupAction}
        title="Create an account"
        submitLabel="Create account"
        passwordAutoComplete="new-password"
        footer={
          <>
            Already have an account? <Link href="/login">Sign in</Link>
          </>
        }
      />
    </main>
  )
}
