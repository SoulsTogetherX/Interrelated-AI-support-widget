//#region Boot-time assertions
// Next's one server-start hook — the closest thing this framework has to
// realtime's server.ts boot spine. Production must refuse to START without
// the email-crypto secrets, not throw on the first signup: the lazy readers
// in emailCrypto.ts are only reached from register/login, so without this a
// misdeployed dashboard would boot cleanly, pass every health check, and
// 500 on the first real user (the whiteboard shipped exactly that bug; its
// fix is ported with the file).
//
// NEXT_RUNTIME gating: register() also runs for the edge runtime bundle,
// where node:crypto does not exist — only the nodejs server does real work.
//#endregion

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return
  }
  if (process.env.NODE_ENV === "production") {
    const { assertEmailSecretsPresent } = await import("@/lib/auth/emailCrypto")
    assertEmailSecretsPresent()
  }
}
