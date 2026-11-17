/**
 * Application Default Credentials, the opt-in headless mode (design §3.2, L12): `GOOGLE_APPLICATION_CREDENTIALS` (a
 * service-account key, an external-account/WIF config or an impersonated service account), gcloud's ADC file, or the
 * metadata server, through the bundled `google-auth-library`; `accounts.<alias>.impersonate` mints a token for that
 * service account. A key and an impersonation request `bigquery` alone (design §3.2); a gcloud user credential has
 * whatever scopes it was created with, which is why status warns `SCOPE_WIDER_THAN_LEVEL` and the docs name the narrower
 * `gcloud auth application-default login --scopes=…` command.
 *
 * ADC is never a fallback: an account is `adc` only when its options say so. A managed (hosted) engine refuses it
 * unless `allowAdcInHost` is set (`ADC_REFUSED`). The signal for "managed" is the family's: Jelly's agent runtime sets
 * `OPENCODE_DISABLE_PROJECT_CONFIG=1` (or the older `OPENCODE_CONFIG_PROJECT_DISABLE=1`) for its managed engines.
 */
import { BigQueryError } from "../domain/errors.js"
import { SCOPES } from "../domain/levels.js"
import type { AdcLibrary } from "./adc-library.js"

/** The scope an ADC account requests, unless the account's `scopes` option adds more: `bigquery` alone (design §3.2). */
export const ADC_SCOPES: readonly string[] = [SCOPES.bigquery]

export interface AdcEnvironment {
  readonly library: AdcLibrary
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly impersonate?: string
  readonly scopes?: readonly string[]
}

export interface AdcToken {
  readonly token: string
  readonly expiresAt: number
  /** The scopes Google reports for the token, or the requested ones when the client cannot report them. */
  readonly scopes: readonly string[]
  readonly email?: string
  /** True when the email is a principal this credential proves (a key's `client_email`, or an impersonation target). */
  readonly verified: boolean
}

/** True for a managed (hosted) engine, where ADC is refused unless the operator opted in (design §3.2). */
export function isManagedHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["OPENCODE_DISABLE_PROJECT_CONFIG"] === "1" || env["OPENCODE_CONFIG_PROJECT_DISABLE"] === "1"
}

const UNAVAILABLE_NEXT =
  "Set GOOGLE_APPLICATION_CREDENTIALS, or run `gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/bigquery`."

/** Mints one ADC access token, for the account's key or the impersonated service account. */
export async function adcToken(input: AdcEnvironment): Promise<AdcToken> {
  const now = input.now ?? Date.now
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : ADC_SCOPES
  let auth: { getClient(): Promise<import("./adc-library.js").AdcClient>; getCredentials(): Promise<import("./adc-library.js").AdcCredentials> }
  try {
    auth = new input.library.GoogleAuth({ scopes })
  } catch {
    throw unavailable("Application Default Credentials could not be loaded")
  }
  let client: import("./adc-library.js").AdcClient
  try {
    const source = await auth.getClient()
    client = input.impersonate ? new input.library.Impersonated({ sourceClient: source, targetPrincipal: input.impersonate, targetScopes: scopes }) : source
  } catch {
    throw unavailable("Application Default Credentials found no usable credential on this machine")
  }
  let token: string | undefined
  let expiresAt = now() + 3_600_000
  try {
    const answer = await client.getAccessToken()
    token = answer.token ?? undefined
    const expiry = answer.res?.data?.expiry_date
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0) expiresAt = expiry
  } catch {
    throw unavailable(input.impersonate ? `Google refused to impersonate ${input.impersonate}` : "Application Default Credentials could not mint an access token")
  }
  if (!token) throw unavailable("Application Default Credentials returned no access token")
  // The token's real scopes, when the client can report them; a gcloud user credential often has cloud-platform.
  let granted: readonly string[] = scopes
  let reportedEmail: string | undefined
  let reportedVerified = false
  if (client.getTokenInfo) {
    try {
      const info = await client.getTokenInfo(token)
      if (Array.isArray(info.scopes) && info.scopes.length > 0) granted = info.scopes
      if (typeof info.email === "string" && /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(info.email)) {
        reportedEmail = info.email.toLowerCase()
        reportedVerified = info.verified_email === true
      }
    } catch {
      // A token-info failure only loses the scope warning and the email; the token still works.
    }
  }
  let keyEmail: string | undefined
  try {
    const credentials = await auth.getCredentials()
    if (typeof credentials.client_email === "string" && /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(credentials.client_email)) keyEmail = credentials.client_email.toLowerCase()
  } catch {
    // A user credential has no client_email; the token-info answer may name it.
  }
  const email = input.impersonate ?? keyEmail ?? reportedEmail
  const verified = input.impersonate !== undefined || keyEmail !== undefined || reportedVerified
  return { token, expiresAt, scopes: granted, ...(email !== undefined ? { email } : {}), verified }
}

/** ADC_REFUSED, raised before the library is loaded in a managed host without the opt-in. */
export function adcRefused(alias: string): BigQueryError {
  return new BigQueryError("ADC_REFUSED", `The account ${alias} uses Application Default Credentials, which a managed host refuses unless allowAdcInHost is set`, `Sign in interactively for ${alias}, or ask the operator to set allowAdcInHost: true.`)
}

/** ADC_UNAVAILABLE, with the gcloud command that fixes it (design L3). */
function unavailable(detail: string): BigQueryError {
  return new BigQueryError("ADC_UNAVAILABLE", detail, UNAVAILABLE_NEXT)
}
