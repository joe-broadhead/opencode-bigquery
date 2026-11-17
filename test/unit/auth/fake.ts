/**
 * Package A's test doubles: Google's token endpoint and token-info endpoint in memory (no socket, no network), a fake
 * OpenCode credential store, and invented tokens in Google's shapes. Nothing here is a real credential and nothing
 * reaches the network.
 */
import { createHash } from "node:crypto"
import { type AuthHost, type HostConnection, type HostCredential } from "../../../src/auth/state.js"
import type { PublicJwk } from "../../../src/auth/keys.js"
import { SCOPES } from "../../../src/domain/levels.js"

export interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly form: Readonly<Record<string, string>>
}

export interface FakeAnswer {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

export type Handler = (request: Recorded) => FakeAnswer | Promise<FakeAnswer>

/** Google's token and token-info endpoints; every other URL is a test failure, never a real request. */
export class FakeTokenEndpoint {
  readonly requests: Recorded[] = []
  /** The raw DPoP header per request, decoded by `proofs`; never printed by a test. */
  private readonly rawProofs: { readonly request: Recorded; readonly proof: string }[] = []
  private handler: Handler = (request) => (request.url.includes("/tokeninfo") ? { status: 200, body: { email: "ada@example.invalid", email_verified: true } } : this.defaultToken(request))

  /** Replaces the handler from now on. */
  answer(handler: Handler): this {
    this.handler = handler
    return this
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const text = await request.text()
    const form: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(text)) form[key] = value
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = key.toLowerCase() === "dpop" ? "[proof]" : key.toLowerCase() === "authorization" ? "[token]" : value
    })
    const recorded: Recorded = { url: request.url, method: request.method, headers, form }
    const proof = request.headers.get("DPoP")
    if (proof) this.rawProofs.push({ request: recorded, proof })
    this.requests.push(recorded)
    const url = new URL(request.url)
    if (!((url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") || (url.hostname === "oauth2.googleapis.com" && url.pathname === "/tokeninfo"))) {
      throw new Error(`EXTERNAL_FETCH_BLOCKED: the auth tests do not reach ${url.origin}${url.pathname}`)
    }
    const answer = await this.handler(recorded)
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json", ...(answer.headers ?? {}) } })
  }) as typeof globalThis.fetch

  /** The proofs this endpoint received: which request carried one, and its decoded claims. */
  get proofs(): { readonly request: Recorded; readonly header: Record<string, unknown>; readonly payload: Record<string, unknown>; readonly signingInput: string; readonly signature: string }[] {
    return this.rawProofs.flatMap(({ request, proof }) => {
      const parts = proof.split(".")
      if (parts.length !== 3) return []
      return [{ request, header: JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")), payload: JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")), signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2]! }]
    })
  }

  /** Requests to Google's revocation endpoints: always none (design §3.1). */
  get revocations(): Recorded[] {
    return this.requests.filter((request) => request.url.includes("/revoke"))
  }

  get tokenRequests(): Recorded[] {
    return this.requests.filter((request) => new URL(request.url).pathname === "/token")
  }

  private defaultToken(request: Recorded): FakeAnswer {
    if (request.form["grant_type"] === "authorization_code") {
      return { status: 200, body: inventedTokenSet({ scope: [SCOPES.openid, SCOPES.email, SCOPES.bigquery].join(" ") }) }
    }
    // A refresh with no proof: Google's 400 is what "bound" means.
    if (!request.headers["dpop"]) return { status: 400, body: { error: "invalid_request", error_description: "DPoP proof required" } }
    return { status: 200, body: inventedTokenSet({ scope: [SCOPES.openid, SCOPES.email, SCOPES.bigquery].join(" ") }) }
  }
}

/** An invented token answer. */
export function inventedTokenSet(overrides: { readonly scope?: string; readonly refresh?: string | null; readonly idToken?: string | null; readonly expiresIn?: number } = {}): Record<string, unknown> {
  return {
    access_token: "ya29.invented-access-token-for-tests-only",
    expires_in: overrides.expiresIn ?? 3600,
    token_type: "Bearer",
    scope: overrides.scope ?? [SCOPES.openid, SCOPES.email, SCOPES.bigquery].join(" "),
    ...(overrides.refresh === null ? {} : { refresh_token: overrides.refresh ?? "1//invented-refresh-token-for-tests-only" }),
    ...(overrides.idToken === null ? {} : { id_token: overrides.idToken ?? inventedIdToken() }),
  }
}

/** An invented unsigned id_token in Google's claims, enough for the claims checks (the signature is never read). */
export function inventedIdToken(overrides: { readonly clientId?: string; readonly email?: string; readonly verified?: boolean | string; readonly exp?: number; readonly iss?: string } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: overrides.iss ?? "https://accounts.google.com",
      aud: overrides.clientId ?? "invented.apps.googleusercontent.com",
      sub: "10769150350006150715113082367",
      email: overrides.email ?? "ada@example.invalid",
      email_verified: overrides.verified ?? true,
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url")
  return `${header}.${payload}.invented-signature`
}

/** Verifies a DPoP proof's ES256 signature against the JWK its own header carries (and the key the sign-in returned). */
export async function proofSignatureValid(p: { readonly header: Record<string, unknown>; readonly signingInput: string; readonly signature: string }): Promise<boolean> {
  const { verify, createPublicKey } = await import("node:crypto")
  const jwk = p.header["jwk"] as PublicJwk | undefined
  if (!jwk) return false
  const key = createPublicKey({ key: jwk as never, format: "jwk" })
  return verify("sha256", Buffer.from(p.signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(p.signature, "base64url"))
}

/** A fake OpenCode credential store: one active OAuth credential, reported and resolved. */
export class FakeHost implements AuthHost {
  credential: HostCredential | undefined
  readonly reports: { readonly integrationID: string; readonly message: string }[] = []
  readonly connection: HostConnection = { id: "connection-invented-1", type: "credential" }

  async active(integrationID: string): Promise<HostConnection | undefined> {
    return this.credential && integrationID.length > 0 ? this.connection : undefined
  }

  async resolve(): Promise<HostCredential | undefined> {
    return this.credential
  }

  async report(integrationID: string, _connection: HostConnection, message: string): Promise<void> {
    this.reports.push({ integrationID, message })
  }
}

/** The refresh token in the fake credential, for assertions. */
export function refreshOf(credential: HostCredential | undefined): string | undefined {
  return credential?.refresh
}

/** SHA-256, base64url: what a code exchange's `jti` must be. */
export const codeHash = (code: string) => createHash("sha256").update(code, "utf8").digest("base64url")
