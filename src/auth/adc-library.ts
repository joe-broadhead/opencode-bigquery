/**
 * The bundled `google-auth-library`, for the opt-in `adc` mode only (design §3.2). It is loaded on first use, so the
 * plugin's start-up never runs it. esbuild bundles it into dist/index.js (scripts/build.mjs): the package keeps no
 * runtime dependency, and NOTICE carries its licences.
 *
 * The types below are the small structural surface package A uses, so the ADC path is testable with a fake and the
 * library's own CommonJS build never leaks into the rest of the code.
 */
export interface AdcCredentials {
  readonly client_email?: string
  readonly type?: string
  readonly [key: string]: unknown
}

export interface AdcTokenInfo {
  readonly email?: string
  readonly verified_email?: boolean
  readonly scopes?: readonly string[]
}

export interface AdcClient {
  getAccessToken(): Promise<{ readonly token?: string | null; readonly res?: { readonly data?: { readonly expiry_date?: number | null } } }>
  /** Present on OAuth2-based clients (a key, a user credential, an impersonated one); absent on some external accounts. */
  getTokenInfo?(accessToken: string): Promise<AdcTokenInfo>
}

export interface AdcAuth {
  getClient(): Promise<AdcClient>
  getCredentials(): Promise<AdcCredentials>
}

export interface AdcLibrary {
  readonly GoogleAuth: new (options: { readonly scopes?: readonly string[] }) => AdcAuth
  readonly Impersonated: new (options: { readonly sourceClient: AdcClient; readonly targetPrincipal: string; readonly targetScopes: readonly string[] }) => AdcClient
}

export async function loadAdcLibrary(): Promise<AdcLibrary> {
  const { GoogleAuth, Impersonated } = await import("google-auth-library")
  return { GoogleAuth: GoogleAuth as unknown as AdcLibrary["GoogleAuth"], Impersonated: Impersonated as unknown as AdcLibrary["Impersonated"] }
}
