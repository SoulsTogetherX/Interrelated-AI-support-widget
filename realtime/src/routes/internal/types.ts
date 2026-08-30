//#region Types
import type { NextFunction, Request, Response } from "express"

import type { UrlVet } from "@/credentials/validate"

interface InternalRouteOptions {
  /** The shared secret. app.ts only mounts this surface when present;
   *  server.ts refuses a secret shorter than 32 chars at boot. */
  secret: string
  /** The widget token secret, from which handoff-ticket keys are derived
   *  (M4.2). Same value the socket verifies with — passed rather than read
   *  from env here so tests can drive both ends deterministically. */
  ticketSecret: string
  /** Injectable URL vet, applied to credential base URLs AND source
   *  locations alike (tests reach loopback fakes; production default
   *  rejects anything non-public). */
  vetBaseUrl?: UrlVet
  /** Round-trip timeout override for tests. */
  testTimeoutMs?: number
  /** Called after a source is enqueued — server.ts wires this to the
   *  ingest worker's wake(), which is the whole production scheduling
   *  mechanism (wake-driven mode has no poll to fall back on). */
  onEnqueue?: () => void
  /** Called after a handoff is closed — server.ts wires this to the socket
   *  server's endRoom(), so the two people in the conversation are TOLD it
   *  ended rather than left to infer it from a dropped connection (M4.6).
   *  Optional for the same reason onEnqueue is: a stack without a socket
   *  server still has a working close. */
  onHandoffClosed?: (conversationId: string) => void
}

/** The guard pair every registrar receives — built once in index.ts. */
interface InternalGuards {
  requireSecret: (req: Request, res: Response, next: NextFunction) => void
  requireOrg: (req: Request, res: Response, next: NextFunction) => Promise<void> | void
}
//#endregion

//#region Exports
export type { InternalRouteOptions, InternalGuards }
//#endregion
