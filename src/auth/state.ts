/**
 * The seam between the auth port and OpenCode's integration directory, plus the state one plugin instance shares between
 * them.
 *
 * `createAuthPort` is built before the plugin's `setup` has a host context (`src/wiring.ts` has no `ctx`), and OpenCode
 * owns the credential store. Both sides therefore key this state by the exact `Options` object the plugin passed to
 * `createPorts` and to `registerAuth`; the planned setup call passes one object to both. A second plugin instance in one
 * process gets its own entry, and disposing one registration does not detach another.
 *
 * The types are structural twins of the public plugin API's connection surface, so no private host package is imported.
 */
import { stateDirOf } from "./keys.js"

/** OpenCode's connection info, reduced to what auth reads. */
export interface HostConnection {
  readonly id?: string
  readonly type?: string
  readonly [key: string]: unknown
}

/** OpenCode's credential value, reduced to an OAuth credential. */
export interface HostCredential {
  readonly type: string
  readonly methodID?: string
  readonly refresh?: string
  readonly access?: string
  readonly expires?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface AuthHost {
  readonly active: (integrationID: string) => Promise<HostConnection | undefined>
  readonly resolve: (connection: HostConnection) => Promise<HostCredential | undefined>
  /** Marks the connection as needing a sign-in, so the host shows it natively; best effort. */
  readonly report?: (integrationID: string, connection: HostConnection, message: string) => Promise<void>
}

/** One access token, in memory only (design §3.2). */
export interface CachedToken {
  readonly keyId: string
  readonly token: string
  readonly expiresAt: number
  readonly scopes: readonly string[]
}

export interface AuthState {
  host?: AuthHost
  /** `$XDG_STATE_HOME/opencode-bigquery`, or a test's folder. */
  readonly stateDir: string
  /** Access tokens by alias; never written anywhere. */
  readonly tokens: Map<string, CachedToken>
  /** Google's scope list from this process's latest refresh, by `alias|keyId` (design §3.1's second check). */
  readonly refreshed: Map<string, readonly string[]>
  /** A refresh token Google returned on a refresh, when one came back; memory only, for this process. */
  readonly rotated: Map<string, string>
  /** One in-flight refresh per `alias|keyId`, so parallel calls cannot mint two tokens. */
  readonly inflight: Map<string, Promise<CachedToken>>
  /** `DPoP-Nonce` by keyId, as Google last gave it. */
  readonly nonces: Map<string, string>
  /**
   * `alias|keyId` of each Read sign-in whose IAM check has not run yet (review L-4). Status takes it once, so
   * `tables.testIamPermissions` runs at the first status after a Read sign-in, not inside the sign-in callback (the
   * credential is not stored yet, and billingProject may be unset).
   */
  readonly iamPending: Set<string>
}

const states = new WeakMap<object, AuthState>()

/** The state for one plugin instance. */
export function authState(options: object, stateDir: string = stateDirOf()): AuthState {
  const found = states.get(options)
  if (found) return found
  const state: AuthState = { stateDir, tokens: new Map(), refreshed: new Map(), rotated: new Map(), inflight: new Map(), nonces: new Map(), iamPending: new Set() }
  states.set(options, state)
  return state
}

/** Attaches the host's credential store; returns the dispose that detaches it. */
export function attachHost(state: AuthState, host: AuthHost): () => void {
  state.host = host
  return () => {
    if (state.host === host) delete state.host
  }
}

/** The answer key for one sign-in: a re-sign-in makes a new key, so the old answer cannot decide the new level. */
export const answerKey = (alias: string, keyId: string) => `${alias}|${keyId}`

/** Forgets one alias's memory: a new sign-in, or a sign-out. */
export function forgetAlias(state: AuthState, alias: string): void {
  state.tokens.delete(alias)
  for (const key of [...state.refreshed.keys()]) if (key.startsWith(`${alias}|`)) state.refreshed.delete(key)
  for (const key of [...state.rotated.keys()]) if (key.startsWith(`${alias}|`)) state.rotated.delete(key)
  for (const key of [...state.inflight.keys()]) if (key.startsWith(`${alias}|`)) state.inflight.delete(key)
  for (const key of [...state.iamPending]) if (key.startsWith(`${alias}|`)) state.iamPending.delete(key)
}

/**
 * Takes the IAM check's pending marker for one sign-in (review L-4): true once, on the first status that sees it after a
 * Read sign-in. F's status calls this and then `iamCheck`; a write sign-in sets none, and the on-demand checks
 * (`bigquery_status({ include: ["iam"] })` and the doctor) do not consume it. With `keyId`, only that sign-in's marker
 * counts; without it, the alias's pending marker is taken, which is what a tool handler that cannot read the credential's
 * record uses.
 */
export function takePendingIamCheck(options: object, alias: string, keyId?: string): boolean {
  const state = states.get(options)
  if (!state) return false
  if (keyId !== undefined) {
    const key = answerKey(alias, keyId)
    if (!state.iamPending.has(key)) return false
    state.iamPending.delete(key)
    return true
  }
  const key = [...state.iamPending].find((entry) => entry.startsWith(`${alias}|`))
  if (!key) return false
  state.iamPending.delete(key)
  return true
}

/** The OAuth credential of one integration, or undefined when there is no active connection or it is not OAuth. */
export async function activeCredential(host: AuthHost, integrationID: string): Promise<{ readonly connection: HostConnection; readonly credential: HostCredential } | undefined> {
  let connection: HostConnection | undefined
  try {
    connection = await host.active(integrationID)
  } catch {
    return undefined
  }
  if (!connection) return undefined
  let credential: HostCredential | undefined
  try {
    credential = await host.resolve(connection)
  } catch {
    return undefined
  }
  if (!credential || credential.type !== "oauth") return undefined
  return { connection, credential }
}

export async function reportNeedsSignIn(host: AuthHost, integrationID: string, connection: HostConnection, message: string): Promise<void> {
  if (!host.report) return
  try {
    await host.report(integrationID, connection, message)
  } catch {
    // Reporting is best effort; it must never change the call's result.
  }
}
