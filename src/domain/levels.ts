/**
 * The sign-in levels and how the write level is bound to Google's own grant (design §3.1). Package A builds the sign-in;
 * this module is the contract it builds to, and the one place a level is decided.
 *
 * Both levels request `openid`, `userinfo.email` and `bigquery`; Read and write adds the marker `bigquery.insertdata`,
 * which grants nothing `bigquery` does not, but which only Google's consent screen can grant. An account is `write`
 * only when BOTH its sign-in record says `write` AND the scope list of Google's answer to this process's most recent
 * token refresh holds the marker. The stored record's own scope string is never read for this. The `level` option can
 * only lower an account; headless modes (`adc`, `token`) are `read`, full stop.
 */
import * as z from "zod"
import { BigQueryError } from "./errors.js"

export const SCOPES = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  bigquery: "https://www.googleapis.com/auth/bigquery",
  /** The write level's marker: "Insert data into Google BigQuery". Adds no power beyond `bigquery`. */
  writeMarker: "https://www.googleapis.com/auth/bigquery.insertdata",
} as const

export const LEVELS = ["read", "write"] as const
export type Level = (typeof LEVELS)[number]

export const MODES = ["interactive", "adc", "token"] as const
export type Mode = (typeof MODES)[number]

/** The scopes a sign-in at this level requests. */
export function scopesFor(level: Level): readonly string[] {
  const base = [SCOPES.openid, SCOPES.email, SCOPES.bigquery]
  return level === "write" ? [...base, SCOPES.writeMarker] : base
}

/** Every scope either level requests, sorted: what Jelly's `signIns[0].scopes` lists and its Google client allows. */
export const ALL_SCOPES: readonly string[] = [...new Set([...scopesFor("read"), ...scopesFor("write")])].sort()

/**
 * The authorization request's own parameters, beside PKCE and the client. Every interactive sign-in sends
 * `prompt=consent`, so Google shows its consent screen and mints a new device-bound refresh token, and none sends
 * `include_granted_scopes`, so a later Read sign-in returns no marker.
 */
export function authorizationParams(level: Level): Readonly<Record<string, string>> {
  return { scope: scopesFor(level).join(" "), prompt: "consent", access_type: "offline", response_type: "code" }
}

/** Parameters an authorization request must never carry. */
export const FORBIDDEN_AUTHORIZATION_PARAMS: readonly string[] = ["include_granted_scopes"]

/**
 * Google's revocation endpoints. The plugin never calls them: Google revokes every scope the person granted the
 * client's project, signing them out of every app on the same client. Sign-out and replacement are local (a new DPoP key
 * at each sign-in; the old key and refresh token deleted). The fakes fail a test on any request to one.
 */
export const REVOKE_ENDPOINTS: readonly string[] = ["https://oauth2.googleapis.com/revoke", "https://accounts.google.com/o/oauth2/revoke"]

/**
 * What the plugin's sign-in method stores with OpenCode's credential, beside the refresh token and the client. Written
 * only by the sign-in method, and `level: "write"` only when the form's Read and write was chosen and acknowledged.
 */
export const SignInRecordSchema = z.strictObject({
  version: z.literal(1),
  level: z.enum(LEVELS),
  /** The form's "I understand this allows changes"; required for `write`. */
  acknowledged: z.boolean(),
  /** Whether Google bound the refresh token to this device's DPoP key: a refresh without a proof answered 400. */
  binding: z.enum(["bound", "unbound"]),
  /** The DPoP key's id, the file `keys/<alias>.jwk` holds. */
  keyId: z.string().min(1),
  /** The signed-in address, from the ID token. */
  email: z.string().min(3).optional(),
  /** ISO time of the sign-in. */
  signedInAt: z.string().min(1),
})
export type SignInRecord = z.output<typeof SignInRecordSchema>

/** The level and why: `write` only when every check passed; otherwise the refusal a commit gets. */
export type LevelDecision =
  | { readonly level: "write" }
  | {
      readonly level: "read"
      /** Why a commit is refused on this account. */
      readonly refusal: "ACCOUNT_READ_ONLY" | "WRITE_LEVEL_UNVERIFIED" | "WRITE_LEVEL_UNAVAILABLE"
      readonly why: string
    }

export interface LevelInput {
  readonly mode: Mode
  /** The stored sign-in record, when there is one. */
  readonly record?: SignInRecord
  /** The scope list of Google's answer to this process's most recent refresh; undefined before the first refresh. */
  readonly refreshedScopes?: readonly string[]
  /** The account's `level` option: it can only lower. */
  readonly configured?: Level
  /** `WRITE_LEVEL_AVAILABLE` (src/constants.ts), a build constant: false while this release ships with writes off. Never an option. */
  readonly writeAvailable: boolean
}

/**
 * The one decision. Pure: the auth port (`level(account)`) refreshes first, so `refreshedScopes` is Google's answer from
 * this process, and passes it here. A stored scope string is not an input, so it cannot count.
 */
export function decideLevel(input: LevelInput): LevelDecision {
  if (input.mode !== "interactive") return read("ACCOUNT_READ_ONLY", `a ${input.mode} account is read-only`)
  const record = input.record
  if (!record || record.level === "read") return read("ACCOUNT_READ_ONLY", "the account signed in with Read")
  if (input.configured === "read") return read("ACCOUNT_READ_ONLY", "the account's level option lowers it to read")
  if (!record.acknowledged) return read("WRITE_LEVEL_UNVERIFIED", "the sign-in record's write level was not acknowledged on the form")
  if (!input.writeAvailable) return read("WRITE_LEVEL_UNAVAILABLE", "this release ships with the write level turned off")
  if (input.refreshedScopes === undefined) return read("WRITE_LEVEL_UNVERIFIED", "no token refresh has answered in this process yet")
  if (!input.refreshedScopes.includes(SCOPES.writeMarker)) {
    return read("WRITE_LEVEL_UNVERIFIED", "Google's last refresh did not return the write marker scope")
  }
  return { level: "write" }
}

function read(refusal: Extract<LevelDecision, { level: "read" }>["refusal"], why: string): LevelDecision {
  return { level: "read", refusal, why }
}

/** Refuses a commit unless the decision is `write`. Called before any Google request a commit makes. */
export function requireWrite(decision: LevelDecision, account: string): void {
  if (decision.level === "write") return
  throw new BigQueryError(decision.refusal, `The account ${account} cannot commit changes: ${decision.why}`)
}

/** The `level` option on a headless account: only `read` is valid (`OPTIONS_INVALID` at option parse). */
export function headlessLevelProblem(mode: Mode, level: Level | undefined): string | undefined {
  return mode !== "interactive" && level === "write" ? `a ${mode} account can only be read in this version` : undefined
}

/**
 * The disclosure, verbatim on the form under Read, in the jelly account description, the README's Security section,
 * docs/auth.md and status. The unbound form drops the key file, because then the credential store alone is enough.
 */
export const DISCLOSURE = {
  bound:
    "At Read, Google issues a token that can change BigQuery data wherever your Google account is allowed to; this plugin never uses it to, but a program that can read both OpenCode's credential store and this plugin's key file could. For Google itself to refuse changes, have your admin grant you only BigQuery Job User and Data Viewer.",
  unbound:
    "At Read, Google issues a token that can change BigQuery data wherever your Google account is allowed to; this plugin never uses it to, but a program that can read OpenCode's credential store could. For Google itself to refuse changes, have your admin grant you only BigQuery Job User and Data Viewer.",
  /** Added on the form, shown before Google answers. */
  formSuffix: "(if Google does not bind the token to this device, reading the credential store alone is enough; status will say)",
} as const
