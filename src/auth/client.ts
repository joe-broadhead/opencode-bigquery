/**
 * The OAuth client a sign-in uses, where it came from, and the precedence between the places one can be given (design
 * §3.2, the same as gws):
 *
 *   1. `accounts.<alias>.oauthClient`   (the account's own, which organisation config can set)
 *   2. `oauthClient`                    (the plugin's)
 *   3. the sign-in form                (typed in once, or filled by a host's hidden `clientJson`)
 *   4. the previous sign-in for this alias, when it was entered in the form
 *
 * No client ships in the package. A Desktop client's secret is not confidential to Google (PKCE is what protects the
 * flow), but a Web application client's secret is: it can only arrive through the host's hidden `clientJson` field and
 * is kept in OpenCode's credential store, never in the plugin's options.
 */
import { BigQueryError } from "../domain/errors.js"

export interface OAuthClient {
  readonly clientId: string
  /** Absent for a Desktop client used with PKCE alone. */
  readonly clientSecret?: string
  /** Present for a Web application client: the redirect URIs Google matches exactly. */
  readonly redirectUris?: readonly string[]
}

/** Where a sign-in's client came from. Only a `form` client is reused by a later sign-in. */
export type ClientSource = "account" | "plugin" | "form"

export interface ClientChoice {
  readonly client: OAuthClient
  readonly source: ClientSource
}

const CLIENT_ID = /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/
const SECRET = /^\S+$/

/** The option's value, as `src/options.ts` validates it. */
export type ClientOption = { readonly clientId: string; readonly clientSecret?: string } | { readonly installed: { readonly client_id: string; readonly client_secret?: string } }

/**
 * Google's downloaded client JSON: `{"installed": …}` for a Desktop app client, `{"web": …}` with `redirect_uris` for
 * a Web application client. Other keys (project_id, auth_uri, …) are ignored. The message never repeats the JSON,
 * which may hold a confidential secret.
 */
export function parseClientJson(text: string): OAuthClient {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const client = parseClientObject(parsed)
  if (!client) {
    throw new BigQueryError(
      "INPUT_INVALID",
      "The OAuth client JSON is not Google's downloaded client JSON",
      'Pass the file Google Cloud console downloads for the client: {"installed": …} for a Desktop app, or {"web": …} with redirect_uris for a Web application.',
    )
  }
  return client
}

function parseClientObject(value: unknown): OAuthClient | undefined {
  if (!isRecord(value)) return undefined
  const installed = value["installed"]
  if (isRecord(installed) && typeof installed["client_id"] === "string" && CLIENT_ID.test(installed["client_id"])) {
    const secret = installed["client_secret"]
    if (secret !== undefined && (typeof secret !== "string" || !SECRET.test(secret))) return undefined
    return { clientId: installed["client_id"], ...(secret !== undefined ? { clientSecret: secret } : {}) }
  }
  const web = value["web"]
  if (isRecord(web) && typeof web["client_id"] === "string" && CLIENT_ID.test(web["client_id"]) && typeof web["client_secret"] === "string" && SECRET.test(web["client_secret"])) {
    const uris = web["redirect_uris"]
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((uri) => typeof uri === "string" && uri.length > 0)) return undefined
    return { clientId: web["client_id"], clientSecret: web["client_secret"], redirectUris: uris as string[] }
  }
  return undefined
}

/** A client from `accounts.<alias>.oauthClient` or `oauthClient`; `src/options.ts` has already checked its shape. */
export function clientFromOption(value: ClientOption | undefined): OAuthClient | undefined {
  if (!value) return undefined
  if ("installed" in value) {
    return { clientId: value.installed.client_id, ...(value.installed.client_secret !== undefined ? { clientSecret: value.installed.client_secret } : {}) }
  }
  return { clientId: value.clientId, ...(value.clientSecret !== undefined ? { clientSecret: value.clientSecret } : {}) }
}

/** The form's two visible client fields, both or neither. */
export function clientFromForm(clientId: string, clientSecret: string): OAuthClient | undefined {
  if (!clientId && !clientSecret) return undefined
  if (!clientId || !CLIENT_ID.test(clientId)) {
    throw new BigQueryError("INPUT_INVALID", "The OAuth client ID is not a Google client ID", "Enter the client ID of a Desktop app OAuth client: it ends in .apps.googleusercontent.com.")
  }
  if (!clientSecret || !SECRET.test(clientSecret)) {
    throw new BigQueryError("INPUT_INVALID", "The OAuth client needs its secret beside the client ID", "Enter both values from the same Desktop app OAuth client, or leave both blank to reuse the previous sign-in's client.")
  }
  return { clientId, clientSecret }
}

export interface ClientCandidates {
  readonly account?: OAuthClient
  readonly plugin?: OAuthClient
  readonly form?: OAuthClient
  /** The client of this alias's current sign-in; reused only when it was entered in the form. */
  readonly previous?: ClientChoice
}

/** The precedence above. A configured client always wins, so an edit to the form cannot replace the organisation's. */
export function resolveClient(candidates: ClientCandidates): ClientChoice | undefined {
  if (candidates.account) return { client: candidates.account, source: "account" }
  if (candidates.plugin) return { client: candidates.plugin, source: "plugin" }
  if (candidates.form) return { client: candidates.form, source: "form" }
  return candidates.previous?.source === "form" ? candidates.previous : undefined
}

/** The AUTH_CLIENT_REQUIRED refusal, in the one family form. */
export function clientRequired(alias: string, name: string): BigQueryError {
  return new BigQueryError(
    "AUTH_CLIENT_REQUIRED",
    `No OAuth client is configured for ${alias}`,
    `Run /connect and choose ${name}, then enter your Desktop OAuth client ID and secret, or ask your administrator for the oauthClient option.`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
