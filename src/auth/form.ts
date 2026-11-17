/**
 * The sign-in form OpenCode renders before any Google request, and how its answer is read (design §3, §3.1).
 *
 * Two levels, with Read the default: both request `openid`, `userinfo.email` and `bigquery`; **Read and write** adds the
 * marker `bigquery.insertdata` and needs the acknowledgment. The disclosure sits verbatim under Read, as the design
 * requires, with the pre-consent clause about the device binding. A blank, missing or unexpected answer can never
 * request more than Read.
 *
 * Three hidden fields are for a host to fill, never shown: Google's client JSON (a Web application client's secret is
 * confidential, so it never appears in a paid field), and the redirect URI and callback port of a host that serves
 * OpenCode to a browser on another machine (Jelly's relay, design §3.2).
 */
import { BigQueryError } from "../domain/errors.js"
import { DISCLOSURE, type Level, scopesFor } from "../domain/levels.js"
import { clientFromForm, parseClientJson, type OAuthClient } from "./client.js"
import { resolveRedirect, type Redirect } from "./redirect.js"

interface FieldBase {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly required?: boolean
  readonly hidden?: boolean
  readonly when?: readonly { readonly key: string; readonly op: "eq" | "neq"; readonly value: string | number | boolean }[]
}

export interface StringField extends FieldBase {
  readonly type: "string"
  readonly placeholder?: string
  readonly pattern?: string
  readonly default?: string
  readonly options?: readonly { readonly value: string; readonly label: string; readonly description?: string }[]
}

export interface IntegerField extends FieldBase {
  readonly type: "integer"
  readonly minimum?: number
  readonly maximum?: number
  readonly default?: number
}

export interface BooleanField extends FieldBase {
  readonly type: "boolean"
  readonly default?: boolean
}

export type SignInField = StringField | IntegerField | BooleanField
export type SignInForm = readonly SignInField[]

/** `bigquery-<alias>`: the integration Jelly's `signIns[0].integration` names and `/connect` shows. */
export function integrationIdFor(alias: string): string {
  return `bigquery-${/^[a-z][a-z0-9-]*$/.test(alias) ? alias : "account"}`
}

/** The name `/connect` shows; with several interactive accounts each is named, so two sign-ins cannot be confused. */
export function integrationNames(accounts: Readonly<Record<string, { readonly mode: string }>>): Map<string, string> {
  const interactive = Object.keys(accounts).filter((alias) => accounts[alias]?.mode === "interactive")
  return new Map(interactive.map((alias) => [alias, interactive.length > 1 ? `Google Cloud (BigQuery) — ${alias}` : "Google Cloud (BigQuery)"]))
}

/** The scopes a sign-in requests: the level's, plus the account's extra `scopes` option, in that order. */
export function signInScopes(level: Level, extraScopes: readonly string[] = []): readonly string[] {
  return [...scopesFor(level), ...extraScopes.filter((scope) => !scopesFor(level).includes(scope))]
}

/** The sign-in instructions OpenCode shows beside Google's URL. No disclosure here: the form carries it. */
export function authorizationInstructions(alias: string, level: Level, extraScopes: readonly string[] = []): string {
  const scopes = signInScopes(level, extraScopes).join(", ")
  return [
    `Sign in to Google Cloud (BigQuery) for ${alias} with ${level === "write" ? "Read and write" : "Read"} access.`,
    `Google shows its consent screen and asks you to approve exactly these scopes: ${scopes}.`,
    level === "write"
      ? "The extra bigquery.insertdata line lets this plugin commit changes you approve; the plugin checks Google's grant before every commit."
      : "This plugin never commits changes on this sign-in.",
  ].join(" ")
}

/** A pattern the host checks before the plugin runs: the value's format, or blank. */
function pattern(value: RegExp): string {
  return `^\\s*$|${value.source}`
}

const CLIENT_ID = /[A-Za-z0-9-]+\.apps\.googleusercontent\.com/

/**
 * The client ID and secret fields. A client from the options (the account's, or the plugin's) is their hidden default,
 * so the host submits it without showing the secret. Otherwise they are visible for a one-time paste; left blank, the
 * sign-in reuses the client entered at this alias's previous sign-in.
 */
function clientFields(configured: OAuthClient | undefined): readonly [StringField, StringField] {
  const hiddenDefault = configured ? { hidden: true, default: configured.clientId } : {}
  const hiddenSecret = configured ? { hidden: true, ...(configured.clientSecret !== undefined ? { default: configured.clientSecret } : {}) } : {}
  const where = "From a Desktop app OAuth client: Google Cloud console → Google Auth platform → Clients. A Web client works only with a redirect URI the host sets."
  const blank = " Leave both blank to reuse the client from this alias's previous sign-in."
  return [
    {
      key: "clientId",
      type: "string",
      title: "OAuth client ID",
      description: `${where}${blank}`,
      required: false,
      placeholder: "…apps.googleusercontent.com",
      pattern: pattern(CLIENT_ID),
      ...hiddenDefault,
    },
    {
      key: "clientSecret",
      type: "string",
      title: "OAuth client secret",
      description: "The secret of the same Desktop app client. Google treats it as non-confidential for installed apps; it is kept with the sign-in in OpenCode's credential store.",
      required: false,
      placeholder: "GOCSPX-…",
      pattern: pattern(/\S+/),
      ...hiddenSecret,
    },
  ]
}

/** The fields a host fills: a client JSON, and the redirect and callback port, defaulting to the plugin options. */
function hostFields(redirectUri: string | undefined, callbackPort: number | undefined): readonly [StringField, StringField, IntegerField] {
  return [
    {
      key: "clientJson",
      type: "string",
      title: "OAuth client JSON",
      description: 'Google\'s downloaded client JSON, {"installed": …} or {"web": …}. When set, it replaces the client ID and secret. Kept with the sign-in in OpenCode\'s credential store.',
      required: false,
      hidden: true,
    },
    {
      key: "redirectUri",
      type: "string",
      title: "OAuth redirect URI",
      description: "The absolute URL Google redirects to after consent, when the browser is not on this machine. Needs callbackPort. Blank: a loopback redirect.",
      required: false,
      hidden: true,
      pattern: "^\\s*$|^https?://\\S+$",
      ...(redirectUri !== undefined ? { default: redirectUri } : {}),
    },
    {
      key: "callbackPort",
      type: "integer",
      title: "OAuth callback port",
      description: "The port on 127.0.0.1 where the redirect reaches the sign-in's listener.",
      required: false,
      hidden: true,
      minimum: 1,
      maximum: 65_535,
      ...(callbackPort !== undefined ? { default: callbackPort } : {}),
    },
  ]
}

function accessField(alias: string, extraScopes: readonly string[]): StringField {
  const read = signInScopes("read", extraScopes)
  const write = signInScopes("write", extraScopes)
  return {
    key: "access",
    type: "string",
    title: "Access",
    description: `What the plugin may do in BigQuery as ${alias}.`,
    required: true,
    default: "read",
    options: [
      {
        value: "read",
        label: "Read",
        description: `Requests ${read.join(" ")}. ${DISCLOSURE.bound} ${DISCLOSURE.formSuffix}`,
      },
      {
        value: "write",
        label: "Read and write",
        description: `Requests the same scopes plus ${write.filter((scope) => !read.includes(scope)).join(" ")}: commits you approve can change BigQuery data.`,
      },
    ],
  }
}

/**
 * The two-level form with the disclosure and the write acknowledgment. `configured` is the account's or plugin's OAuth
 * client; `redirect` comes from the options and is the hidden fields' default.
 */
export function signInForm(alias: string, configured: OAuthClient | undefined, redirect: { readonly redirectUri?: string; readonly callbackPort?: number } = {}, extraScopes: readonly string[] = []): SignInForm {
  return [
    ...clientFields(configured),
    accessField(alias, extraScopes),
    {
      key: "confirmWrite",
      type: "boolean",
      title: "I understand this allows changes",
      description: `A Read and write sign-in lets plans commit inserts, updates, deletes and other changes you approve. Google's consent screen lists the extra "Insert data into Google BigQuery" line.`,
      required: true,
      default: false,
      when: [{ key: "access", op: "eq", value: "write" }],
    },
    ...hostFields(redirect.redirectUri, redirect.callbackPort),
  ]
}

export interface SignInAnswer {
  readonly level: Level
  /** The client entered in the form, if any. */
  readonly form?: OAuthClient
  /** The redirect a host filled in, when it did. */
  readonly redirect: { readonly redirectUri?: string; readonly callbackPort?: number }
}

function text(answer: Record<string, unknown>, key: string): string {
  const value = answer[key]
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") {
    throw new BigQueryError("INPUT_INVALID", `The ${key} answer is not text`, "Enter the value again, or leave it blank.")
  }
  return value.trim()
}

function port(answer: Record<string, unknown>): number | undefined {
  const raw = answer["callbackPort"]
  if (raw === undefined || raw === null || raw === "") return undefined
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new BigQueryError("INPUT_INVALID", "The callbackPort answer is not a port from 1 to 65535", "Set callbackPort to the local port the redirect reaches, or leave it blank.")
  }
  return value
}

/**
 * Reads a submitted form. Rejects a half-entered client, a bad redirect and an unacknowledged write before any network
 * call. Anything but an explicit `write` with the acknowledgment signs in at Read. When a client is configured, the
 * form's client fields are hidden defaults and are not read at all: the configured client wins, so a hidden empty
 * secret cannot be mistaken for a half-entered one.
 */
export function readAnswer(answer: Record<string, unknown>, options: { readonly configuredClient?: boolean } = {}): SignInAnswer {
  const level: Level = answer["access"] === "write" ? "write" : "read"
  const clientJson = options.configuredClient ? "" : text(answer, "clientJson")
  const form = options.configuredClient ? undefined : clientJson ? parseClientJson(clientJson) : clientFromForm(text(answer, "clientId"), text(answer, "clientSecret"))
  const redirectUri = text(answer, "redirectUri")
  const callbackPort = port(answer)
  if (level === "write" && answer["confirmWrite"] !== true) {
    throw new BigQueryError(
      "INPUT_INVALID",
      "Read and write was chosen without the acknowledgment",
      "Sign in again, tick \"I understand this allows changes\", or choose Read.",
    )
  }
  const redirect = { ...(redirectUri ? { redirectUri } : {}), ...(callbackPort !== undefined ? { callbackPort } : {}) }
  // Fails before the browser opens, with INPUT_INVALID, when the two fields do not fit together.
  if (redirectUri || callbackPort !== undefined) resolveRedirect(redirect)
  return { level, ...(form ? { form } : {}), redirect }
}

/** The redirect for one sign-in, resolved from the form's hidden fields or the plugin options. */
export function redirectFor(answer: SignInAnswer, options: { readonly redirectUri?: string; readonly callbackPort?: number }): Redirect {
  return resolveRedirect({
    ...(answer.redirect.redirectUri !== undefined ? { redirectUri: answer.redirect.redirectUri } : options.redirectUri !== undefined ? { redirectUri: options.redirectUri } : {}),
    ...(answer.redirect.callbackPort !== undefined ? { callbackPort: answer.redirect.callbackPort } : options.callbackPort !== undefined ? { callbackPort: options.callbackPort } : {}),
  })
}
