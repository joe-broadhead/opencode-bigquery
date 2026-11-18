/**
 * The session id as the ledger and a job's labels may hold it: a hash, never the id (design §6.2 item 7, §5.6). Sixteen
 * hex characters is enough to group one session's jobs and says nothing about the session.
 */
import { createHash } from "node:crypto"

export function sessionHash(sessionID: string): string {
  return createHash("sha256").update(sessionID, "utf8").digest("hex").slice(0, 16)
}
