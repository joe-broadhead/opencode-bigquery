/**
 * Google's OAuth token endpoint, with DPoP (design §3.2, §14.1; Google's desktop-app page, §17 [27]).
 *
 * Every shape here comes from that page:
 * - the authorize URL carries PKCE S256, `prompt=consent`, `access_type=offline`, the level's scopes, and never
 *   `include_granted_scopes`;
 * - the code exchange sends a DPoP proof whose `jti` is BASE64URL(SHA256(code)); every refresh sends a proof with a
 *   unique per-request `jti`; the access token stays `Bearer`;
 * - a `DPoP-Nonce` the server returns is cached per key and sent in the next proof; a `use_dpop_nonce` error is retried
 *   once with the nonce its answer carries;
 * - a bound refresh token answered a refresh *without* a proof with 400, which is how the sign-in records `bound` or
 *   `unbound`.
 *
 * Google's error text and code are used only to classify a refusal; they never reach a `message` or `next` (design
 * §5.6). The plugin never calls `/revoke`: Google's revocation is project-wide (§3.1).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { BigQueryError } from "../domain/errors.js"
import { GOOGLE } from "../domain/google.js"
import type { Level } from "../domain/levels.js"
import { codeJti, dpopProof, randomState, refreshJti } from "./dpop.js"
import { authorizationInstructions, signInScopes } from "./form.js"
import { createPkce } from "./pkce.js"
import type { OAuthClient } from "./client.js"
import type { Redirect } from "./redirect.js"
import { type DpopKey, generateKey } from "./keys.js"

export const TOKEN_ENDPOINT = GOOGLE.token
/** Google's token-info endpoint, used only to name a `token` account's email (design §10's `probe`). */
export const TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo"
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_BODY = 64 * 1024

export interface GoogleAuthOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly timeoutMs?: number
}

export interface TokenSet {
  readonly access: string
  readonly refresh?: string
  readonly expiresIn: number
  readonly scopes?: readonly string[]
  readonly idToken?: string
}

export type TokenBinding = "bound" | "unbound"

export interface SignInResult {
  readonly tokens: TokenSet & { readonly refresh: string }
  readonly key: DpopKey
  readonly binding: TokenBinding
  /** The `DPoP-Nonce` Google gave during the exchange, for the caller's cache. */
  readonly nonce?: string
}

export interface Authorization {
  readonly url: string
  readonly instructions: string
  readonly expiresAt: number
  readonly mode: "auto"
  readonly callback: Promise<SignInResult>
}

export interface TokenFailure {
  readonly status: number
  readonly error: string
  readonly subtype?: string
  readonly description?: string
  readonly retryAfterSec?: number
}

interface TokenRequest {
  readonly form: Readonly<Record<string, string>>
  /** Present for a DPoP proof; absent only for the deliberate proof-less binding probe. */
  readonly key?: DpopKey
  readonly jti?: string
  readonly nonce?: string
  readonly fetch: typeof globalThis.fetch
  readonly signal?: AbortSignal
  readonly now: () => number
}

interface TokenAnswer {
  readonly status: number
  readonly tokens?: TokenSet
  readonly failure?: TokenFailure
  /** The `DPoP-Nonce` header of the last answer, success or failure. */
  readonly nonce?: string
  /** True when the request was retried once after `use_dpop_nonce`. */
  readonly retried: boolean
}

/**
 * One token request, with the one `use_dpop_nonce` retry Google's page describes. Never throws for an HTTP error; the
 * caller classifies it. A network failure is `UNAVAILABLE`, and an aborted call is `CANCELLED`.
 */
export async function requestToken(input: TokenRequest): Promise<TokenAnswer> {
  let nonce = input.nonce
  let retried = false
  for (;;) {
    const proof = input.key && input.jti ? dpopProof(input.key, { jti: input.jti, now: input.now(), ...(nonce !== undefined ? { nonce } : {}) }) : undefined
    const body = new URLSearchParams(input.form).toString()
    let response: Response
    try {
      response = await input.fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          ...(proof ? { DPoP: proof } : {}),
        },
        body,
        redirect: "error",
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch (error) {
      if (isAbort(error, input.signal)) throw new BigQueryError("CANCELLED", "The sign-in request was stopped")
      throw new BigQueryError("UNAVAILABLE", "Google's token endpoint could not be reached", "Try again; if it repeats, check the network.")
    }
    const answerNonce = response.headers.get("DPoP-Nonce") ?? undefined
    const text = await readText(response)
    const parsed = parseJson(text)
    if (response.ok) {
      const tokens = tokenSet(parsed)
      if (!tokens) return { status: response.status, failure: { status: response.status, error: "invalid_response" }, ...(answerNonce !== undefined ? { nonce: answerNonce } : {}), retried }
      return { status: response.status, tokens, ...(answerNonce !== undefined ? { nonce: answerNonce } : {}), retried }
    }
    const failure = failureOf(response, parsed)
    // The retry is allowed once, only with a proof and only with the nonce the error carries.
    if (failure.error === "use_dpop_nonce" && !retried && input.key && answerNonce) {
      retried = true
      nonce = answerNonce
      continue
    }
    return { status: response.status, failure, ...(answerNonce !== undefined ? { nonce: answerNonce } : {}), retried }
  }
}

/** The authorization-code exchange (Google's desktop page, step 5). */
export async function exchangeCode(input: {
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
  readonly client: OAuthClient
  readonly key: DpopKey
  readonly nonce?: string
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly signal?: AbortSignal
}): Promise<{ readonly tokens: TokenSet; readonly nonce?: string }> {
  const answer = await requestToken({
    form: {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      client_id: input.client.clientId,
      ...(input.client.clientSecret !== undefined ? { client_secret: input.client.clientSecret } : {}),
    },
    key: input.key,
    jti: codeJti(input.code),
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    fetch: input.fetch,
    now: input.now,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (answer.failure) throw classify(answer.failure, "exchange")
  return { tokens: answer.tokens!, ...(answer.nonce !== undefined ? { nonce: answer.nonce } : {}) }
}

/** A refresh, with a fresh per-request `jti` (Google's desktop page, "Refresh an access token"). */
export async function refreshAccessToken(input: {
  readonly refreshToken: string
  readonly client: OAuthClient
  readonly key: DpopKey
  readonly nonce?: string
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly signal?: AbortSignal
}): Promise<{ readonly tokens: TokenSet; readonly nonce?: string }> {
  const answer = await requestToken({
    form: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.client.clientId,
      ...(input.client.clientSecret !== undefined ? { client_secret: input.client.clientSecret } : {}),
    },
    key: input.key,
    jti: refreshJti(),
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    fetch: input.fetch,
    now: input.now,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (answer.failure) throw classify(answer.failure, "refresh")
  return { tokens: answer.tokens!, ...(answer.nonce !== undefined ? { nonce: answer.nonce } : {}) }
}

/**
 * The deliberate refresh **without** a proof right after the exchange (design §3.2, R3-M2): Google must answer 400 for
 * a refresh token it bound to the key; a 200 means the token is not device-bound, and the unbound disclosure applies.
 * Any other answer is treated as unbound, which can only overstate the risk, never understate it.
 */
export async function probeBinding(input: {
  readonly refreshToken: string
  readonly client: OAuthClient
  readonly nonce?: string
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly signal?: AbortSignal
}): Promise<TokenBinding> {
  try {
    const answer = await requestToken({
      form: {
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: input.client.clientId,
        ...(input.client.clientSecret !== undefined ? { client_secret: input.client.clientSecret } : {}),
      },
      fetch: input.fetch,
      now: input.now,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    return answer.status === 400 ? "bound" : "unbound"
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "CANCELLED") throw error
    return "unbound"
  }
}

/**
 * Google's token-info endpoint for an opaque access token, used only for a `token` account's identity. Its answer may
 * carry an email and `email_verified`; nothing else is read, and a failure is not an error (the identity is unknown).
 */
export async function tokenInfo(input: { readonly token: string; readonly fetch: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<{ readonly email?: string; readonly verified: boolean } | undefined> {
  let response: Response
  try {
    // The POST form of Google's token-info endpoint keeps the token in the Authorization header, not in a URL. Its
    // shape is google-auth-library's `OAuth2Client.getTokenInfo` (the same endpoint and fields).
    response = await input.fetch(TOKENINFO_ENDPOINT, {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${input.token}` },
      redirect: "error",
      ...(input.signal ? { signal: input.signal } : {}),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const parsed = parseJson(await readText(response))
  if (!parsed) return undefined
  const email = typeof parsed["email"] === "string" && /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(parsed["email"]) ? parsed["email"].toLowerCase() : undefined
  const verified = parsed["email_verified"] === true || parsed["email_verified"] === "true"
  return email ? { email, verified } : { verified: false }
}

/**
 * One interactive sign-in. Returns Google's URL and a promise of the tokens, with a loopback listener (or the host's
 * relay port) receiving the code. Nothing is fetched from the authorize URL: the person's browser does that.
 */
export async function authorizeGoogle(input: {
  readonly alias: string
  readonly client: OAuthClient
  readonly level: Level
  /** The account's extra `scopes` option, requested and shown with the level's. */
  readonly extraScopes?: readonly string[]
  readonly redirect: Redirect
  readonly options?: GoogleAuthOptions
}): Promise<Authorization> {
  const options = input.options ?? {}
  const fetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pkce = createPkce()
  const state = randomState()
  const key = generateKey()
  const extraScopes = input.extraScopes ?? []

  let resolveCallback!: (result: SignInResult) => void
  let rejectCallback!: (error: Error) => void
  const callback = new Promise<SignInResult>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  // The host may abandon an attempt without awaiting the promise; mark the rejection handled.
  void callback.catch(() => {})

  let finished = false
  let processing = false
  let redirectUri = input.redirect.uri
  let timer: NodeJS.Timeout | undefined

  const finish = async (error?: Error, result?: SignInResult): Promise<void> => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    await closeServer(server)
    if (error) rejectCallback(error)
    else if (result) resolveCallback(result)
    else rejectCallback(new BigQueryError("AUTH_REQUIRED", "The Google sign-in produced no credential", "Run /connect and choose BigQuery again."))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== "GET") {
        respond(response, 405, "Method not allowed", "<p>Use the sign-in link from OpenCode.</p>")
        return
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (!input.redirect.paths.includes(url.pathname)) {
        respond(response, 404, "Not found", "<p>This is not the OAuth callback.</p>")
        return
      }
      if (finished) {
        respond(response, 409, "Sign-in already finished", "<p>This sign-in attempt has already completed.</p>")
        return
      }
      const returnedState = url.searchParams.get("state") ?? ""
      const oauthError = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      if (!returnedState && !oauthError && !code) {
        respond(response, 400, "Waiting for Google sign-in", "<p>Open the sign-in link from OpenCode.</p>")
        return
      }
      if (!stateMatches(returnedState, state)) {
        respond(response, 400, "Sign-in failed", "<p>The OAuth state did not match. Start the sign-in again.</p>")
        await finish(new BigQueryError("AUTH_REQUIRED", "The Google sign-in's state did not match", "Run /connect and choose BigQuery again."))
        return
      }
      if (oauthError) {
        const safe = /^[A-Za-z0-9_.-]{1,80}$/.test(oauthError) ? oauthError : "authorization failed"
        respond(response, 400, "Sign-in failed", `<p>Google returned: ${escapeHtml(safe)}.</p>`)
        await finish(
          new BigQueryError(
            "AUTH_REQUIRED",
            safe === "access_denied" ? "Google's consent screen was declined" : `Google refused the sign-in (${safe})`,
            "Sign in again and approve every scope listed, or ask your administrator.",
          ),
        )
        return
      }
      if (!code) {
        respond(response, 400, "Sign-in failed", "<p>The callback did not include an authorization code.</p>")
        await finish(new BigQueryError("AUTH_REQUIRED", "The Google callback carried no authorization code", "Run /connect and choose BigQuery again."))
        return
      }
      if (processing) {
        respond(response, 409, "Sign-in in progress", "<p>This sign-in attempt is already being completed.</p>")
        return
      }
      processing = true
      try {
        const exchanged = await exchangeCode({ code, verifier: pkce.verifier, redirectUri, client: input.client, key, fetch, now })
        if (!exchanged.tokens.refresh) {
          throw new BigQueryError(
            "AUTH_REQUIRED",
            "Google returned no refresh token",
            "Sign in again; if it repeats, remove this app's access at https://myaccount.google.com/permissions and sign in again.",
          )
        }
        const binding = await probeBinding({ refreshToken: exchanged.tokens.refresh, client: input.client, fetch, now })
        if (!finished) respond(response, 200, "Google Cloud (BigQuery) connected", "<p>Authentication is complete. You can close this window.</p>")
        await finish(undefined, {
          tokens: { ...exchanged.tokens, refresh: exchanged.tokens.refresh },
          key,
          binding,
          ...(exchanged.nonce !== undefined ? { nonce: exchanged.nonce } : {}),
        })
      } catch (error) {
        if (!finished) {
          respond(response, 500, "Sign-in failed", "<p>OpenCode could not complete the Google token exchange. Check the terminal for the next step.</p>")
        }
        await finish(toError(error))
      }
    } catch {
      if (!finished) respond(response, 500, "Sign-in failed", "<p>OpenCode could not process the local OAuth callback.</p>")
      await finish(new BigQueryError("AUTH_REQUIRED", "The local OAuth callback could not be processed", "Run /connect and choose BigQuery again."))
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response)
  })

  try {
    const port = await listenOnLoopback(server, input.redirect.port)
    if (!redirectUri) redirectUri = `http://127.0.0.1:${port}`
  } catch {
    await closeServer(server)
    throw new BigQueryError(
      "INPUT_INVALID",
      input.redirect.port ? `The sign-in could not listen on 127.0.0.1:${input.redirect.port}` : "The sign-in could not start a local callback server",
      input.redirect.port ? `Another program may be using callbackPort ${input.redirect.port}; free it or set another port.` : "Try the sign-in again.",
    )
  }

  server.on("error", () => {
    void finish(new BigQueryError("AUTH_REQUIRED", "The local callback server stopped unexpectedly", "Run /connect and choose BigQuery again."))
  })
  timer = setTimeout(() => {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    void finish(new BigQueryError("AUTH_REQUIRED", `The Google sign-in timed out after ${minutes} minute${minutes === 1 ? "" : "s"}`, "Run /connect and choose BigQuery again."))
  }, timeoutMs)
  timer.unref?.()

  let url: string
  try {
    url = buildAuthorizeUrl({ clientId: input.client.clientId, redirectUri, state, codeChallenge: pkce.challenge, level: input.level, extraScopes })
  } catch (error) {
    await finish(toError(error))
    throw error
  }

  return {
    url,
    instructions: authorizationInstructions(input.alias, input.level, extraScopes),
    expiresAt: now() + timeoutMs,
    mode: "auto",
    callback,
  }
}

/** The authorization URL: PKCE S256, `prompt=consent`, `access_type=offline`, the level's scopes, no `include_granted_scopes`. */
export function buildAuthorizeUrl(input: {
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
  readonly level: Level
  readonly extraScopes?: readonly string[]
}): string {
  const url = new URL(GOOGLE.authorize)
  const params = url.searchParams
  params.set("response_type", "code")
  params.set("client_id", input.clientId)
  params.set("redirect_uri", input.redirectUri)
  params.set("scope", signInScopes(input.level, input.extraScopes ?? []).join(" "))
  params.set("state", input.state)
  params.set("code_challenge", input.codeChallenge)
  params.set("code_challenge_method", "S256")
  params.set("access_type", "offline")
  params.set("prompt", "consent")
  return url.toString()
}

/** Classifies Google's refusal from its code, never from its text (design §5.6). */
export function classify(failure: TokenFailure, what: "exchange" | "refresh"): BigQueryError {
  if (failure.status === 429) {
    return new BigQueryError("RATE_LIMITED", "Google's token endpoint rate-limited the sign-in", "Try again shortly.", failure.retryAfterSec !== undefined ? { retryAfterSec: failure.retryAfterSec } : {})
  }
  if (failure.error === "invalid_response") {
    return new BigQueryError("AUTH_REQUIRED", "Google's token endpoint returned no access token", "Run /connect and choose BigQuery to sign in again.")
  }
  if (failure.status >= 500) {
    return new BigQueryError("UNAVAILABLE", "Google's token endpoint failed", "Try again; if it repeats, check Google's status page.")
  }
  if (failure.error === "invalid_grant") {
    if (isReauthentication(failure)) {
      const hours = reauthenticationHours(failure.description)
      return new BigQueryError(
        "AUTH_REQUIRED",
        `Google refused the refresh: your organisation requires signing in again${hours ? ` every ${hours} hours` : ""}`,
        "Sign in again; a Workspace admin can add the OAuth client to trusted apps and exempt it from the Cloud session limit.",
      )
    }
    return what === "refresh"
      ? new BigQueryError("AUTH_REQUIRED", "Google refused the refresh token", "Run /connect and choose BigQuery to sign in again.")
      : new BigQueryError("AUTH_REQUIRED", "Google refused the authorization code", "Run /connect and choose BigQuery to sign in again.")
  }
  if (failure.error === "invalid_client" || failure.error === "unauthorized_client") {
    return new BigQueryError("AUTH_REQUIRED", "Google refused the OAuth client this sign-in used", "Check the client ID and secret, or ask your administrator for the oauthClient option, then sign in again.")
  }
  if (failure.error === "invalid_dpop_proof" || failure.error === "use_dpop_nonce") {
    return new BigQueryError("AUTH_REQUIRED", "Google refused the DPoP proof for this sign-in", "Check the system clock, then sign in again.")
  }
  if (failure.error === "access_denied") {
    return new BigQueryError("AUTH_REQUIRED", "Google's consent screen was declined", "Sign in again and approve every scope listed.")
  }
  return new BigQueryError("AUTH_REQUIRED", what === "refresh" ? "Google refused the refresh" : "Google refused the authorization code", "Run /connect and choose BigQuery to sign in again.")
}

/** `invalid_grant` with a reauthentication subtype, which is how a Workspace Cloud session limit answers (design §3.2, M8). */
function isReauthentication(failure: TokenFailure): boolean {
  const subtype = failure.subtype ?? ""
  const description = failure.description ?? ""
  return /reauth|rapt|session[_-]?(?:length|limit)|invalid_rapt/i.test(subtype) || /reauth|rapt|session length|session limit/i.test(description)
}

/** N in Google's "sign in again every N hours", when Google's description states it as a small integer; digits only. */
function reauthenticationHours(description: string | undefined): number | undefined {
  if (!description) return undefined
  const match = /(\d{1,4})\s*(?:hour|hours)/i.exec(description)
  if (!match) return undefined
  const hours = Number(match[1])
  return Number.isInteger(hours) && hours > 0 && hours <= 8760 ? hours : undefined
}

function tokenSet(value: Record<string, unknown> | undefined): TokenSet | undefined {
  if (!value) return undefined
  const access = value["access_token"]
  if (typeof access !== "string" || access.length === 0) return undefined
  const refresh = typeof value["refresh_token"] === "string" && value["refresh_token"] ? value["refresh_token"] : undefined
  const raw = value["expires_in"]
  const expires = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
  const expiresIn = Number.isFinite(expires) && expires > 0 ? Math.min(Math.floor(expires), 86_400) : 3600
  const scope = value["scope"]
  const scopes = typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : undefined
  const idToken = typeof value["id_token"] === "string" ? value["id_token"] : undefined
  return { access, ...(refresh !== undefined ? { refresh } : {}), expiresIn, ...(scopes !== undefined ? { scopes } : {}), ...(idToken !== undefined ? { idToken } : {}) }
}

function failureOf(response: Response, parsed: Record<string, unknown> | undefined): TokenFailure {
  const error = parsed && typeof parsed["error"] === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(parsed["error"]) ? parsed["error"] : `http_${response.status}`
  const subtype = parsed && typeof parsed["error_subtype"] === "string" ? parsed["error_subtype"] : undefined
  const description = parsed && typeof parsed["error_description"] === "string" ? parsed["error_description"].slice(0, 500) : undefined
  const retry = Number(response.headers.get("retry-after"))
  return {
    status: response.status,
    error,
    ...(subtype !== undefined ? { subtype } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: Math.ceil(retry) } : {}),
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function readText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text
  } catch {
    return ""
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
}

function toError(error: unknown): Error {
  if (error instanceof BigQueryError) return error
  return new BigQueryError("AUTH_REQUIRED", "The Google sign-in failed", "Run /connect and choose BigQuery again.")
}

function stateMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function listenOnLoopback(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (): void => {
      server.off("listening", onListening)
      reject(new Error("listen failed"))
    }
    const onListening = (): void => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("no address"))
        return
      }
      resolve(address.port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, "127.0.0.1")
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.()
      resolve()
    }, 500)
    timer.unref?.()
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:.5rem 0}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
}

function respond(response: ServerResponse, status: number, title: string, body: string): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  })
  response.end(page(title, body))
}
