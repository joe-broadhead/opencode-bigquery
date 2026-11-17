/**
 * PKCE S256 (RFC 7636), as Google's desktop-app page requires: a 43–128 character verifier from the unreserved set,
 * and `code_challenge = BASE64URL(SHA256(ASCII(verifier)))`. A new pair per authorization request.
 */
import { createHash, randomBytes } from "node:crypto"

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") }
}
