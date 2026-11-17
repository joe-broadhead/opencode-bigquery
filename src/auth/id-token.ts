/**
 * The signed-in Google account, from the `id_token` Google's token endpoint returns because every sign-in requests
 * `openid` (design §3.2, §14.1 "id_token claims"). Google's OpenID Connect page fixes the claims used here: `iss` is
 * Google's issuer, `aud` is the client the sign-in used, `exp` has not passed, and `email` is shown only when
 * `email_verified` is true.
 *
 * The token comes straight from Google's token endpoint over TLS, so, as OpenID Connect Core §3.1.3.7 allows, the TLS
 * check of the issuer stands in for a local signature check; the claims it still requires are checked first. A
 * malformed token, one whose claims do not check out, or one without a verified email gives no identity rather than an
 * error: a sign-in still works without it. Nothing here authorises anything.
 */
export interface SignInIdentity {
  /** The account's email address, only when Google says it is verified. */
  readonly email?: string
}

/** The issuers Google's ID tokens name. */
const GOOGLE_ISSUERS: readonly unknown[] = ["https://accounts.google.com", "accounts.google.com"]

export interface IdTokenExpectation {
  /** The OAuth client ID the sign-in or refresh used: the token's `aud`. */
  readonly clientId: string
  /** Milliseconds since the epoch; the token's `exp` must be after it. */
  readonly now: number
}

/** At most this long: a Google id_token is about 1 KB. */
const MAX_TOKEN_LENGTH = 16 * 1024
const SEGMENT = /^[A-Za-z0-9_-]+$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/

/** The identity in an id_token, or undefined when it holds none this plugin can trust. */
export function idTokenIdentity(token: unknown, expected: IdTokenExpectation): SignInIdentity | undefined {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return undefined
  const parts = token.split(".")
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(claims) || !issuedFor(claims, expected)) return undefined
  const verified = claims["email_verified"] === true || claims["email_verified"] === "true"
  const email = typeof claims["email"] === "string" && EMAIL.test(claims["email"]) ? claims["email"].toLowerCase() : undefined
  if (!verified || email === undefined) return undefined
  return { email }
}

/** OpenID Connect Core 3.1.3.7, steps 2, 3 and 9: Google issued it, for this client, and it has not expired. */
function issuedFor(claims: Record<string, unknown>, expected: IdTokenExpectation): boolean {
  if (!GOOGLE_ISSUERS.includes(claims["iss"])) return false
  const aud = claims["aud"]
  if (!expected.clientId || !(aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId)))) return false
  const exp = claims["exp"]
  return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 > expected.now
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
