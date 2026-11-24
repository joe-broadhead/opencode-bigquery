/**
 * The OAuth redirect of one sign-in (design §3.2, L14).
 *
 * By default Google sends the browser to `http://127.0.0.1:<random port>`, which works only when the browser runs on
 * the same machine as OpenCode. A host that serves OpenCode to a browser elsewhere, an app included, supplies
 * `redirectUri` (the public address Google redirects to) and `callbackPort` (where that address reaches this machine's
 * listener), through the form's hidden fields or the plugin options. Google accepts only loopback redirects for a
 * Desktop app client and matches a Web application client's redirect exactly, so both are checked before the browser
 * opens.
 */
import { BigQueryError } from "../domain/errors.js"
import type { OAuthClient } from "./client.js"

export interface Redirect {
  /** The URI Google redirects to; empty until the loopback listener has a port. */
  readonly uri: string
  /** The port the listener binds; 0 asks for a free one. */
  readonly port: number
  /** The callback paths the listener accepts. */
  readonly paths: readonly string[]
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])

function parse(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** True for an http redirect to this machine, the only kind a Desktop app client accepts. */
export function isLoopback(uri: string): boolean {
  const url = parse(uri)
  return url !== undefined && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
}

/** Why a redirect URI is unusable, or undefined when it is fine. Never echoes the value. */
export function redirectProblem(value: string): string | undefined {
  const url = parse(value.trim())
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return "must be an absolute http or https URL"
  if (url.username || url.password) return "must not carry a user name or password"
  if (url.hash) return "must not have a fragment"
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return "must use https unless it points at 127.0.0.1, [::1] or localhost"
  return undefined
}

function invalid(detail: string): BigQueryError {
  return new BigQueryError("INPUT_INVALID", detail, "Set redirectUri to an absolute https URL and callbackPort to a port from 1 to 65535, or leave both unset for a loopback redirect.")
}

/**
 * The redirect for one sign-in. Neither set: loopback on a random port. Only callbackPort: loopback on that port.
 * redirectUri needs callbackPort, and the listener then accepts only the redirect's own path.
 */
export function resolveRedirect(input: { readonly redirectUri?: string; readonly callbackPort?: number }): Redirect {
  const { redirectUri, callbackPort } = input
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535)) {
    throw invalid("callbackPort is not a port from 1 to 65535")
  }
  if (redirectUri === undefined) {
    const port = callbackPort ?? 0
    return { uri: port ? `http://127.0.0.1:${port}` : "", port, paths: ["/", "/callback"] }
  }
  const problem = redirectProblem(redirectUri)
  if (problem) throw invalid(`The redirectUri ${problem}`)
  if (callbackPort === undefined) throw invalid("redirectUri is set without callbackPort, so the local listener has no port")
  const uri = redirectUri.trim()
  return { uri, port: callbackPort, paths: [new URL(uri).pathname || "/"] }
}

function mismatch(detail: string, next: string): BigQueryError {
  return new BigQueryError("INPUT_INVALID", detail, next)
}

/**
 * Refuses, before the browser opens, a redirect Google would reject for this client: a Desktop app client with a
 * non-loopback redirect, and a Web application client whose registered redirect URIs do not include it exactly.
 * `uri` is undefined for the default random-port loopback.
 */
export function checkClientRedirect(client: OAuthClient, uri: string | undefined): void {
  if (client.redirectUris) {
    if (!uri) {
      throw mismatch(
        "A Web application client needs a fixed redirect, and none is set",
        "Set redirectUri to one of the client's authorised redirect URIs and callbackPort to the local port it reaches, or use a Desktop app client.",
      )
    }
    if (!client.redirectUris.includes(uri)) {
      throw mismatch(
        `The redirect ${uri} is not one of the Web client's authorised redirect URIs; Google matches them character for character`,
        "Add the redirect to the client in Google Cloud console → Google Auth platform → Clients, download its JSON again, and use that; or set redirectUri to one it lists.",
      )
    }
    return
  }
  if (uri && !isLoopback(uri)) {
    throw mismatch(
      `A Desktop app client accepts only a loopback redirect, and ${uri} is not one`,
      "Use a Web application client whose authorised redirect URIs include it, as its downloaded client JSON; or leave redirectUri unset.",
    )
  }
}
