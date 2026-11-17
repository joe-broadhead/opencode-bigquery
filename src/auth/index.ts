/**
 * Package A: the auth port (design §3), the two-level sign-in with the disclosure, the write binding of §3.1
 * (`decideLevel` in `src/domain/levels.ts` plus this module's refresh), DPoP-bound refresh tokens with access tokens in
 * memory, PKCE and the relay, client precedence, the session-control mapping, ADC and token modes, and
 * `/bigquery-doctor` with the IAM check.
 *
 * Two entry points:
 * - `createAuthPort` builds the port `src/wiring.ts` hands to every tool: `token`, `level`, `identity` and `accounts`.
 * - `registerAuth` is the host registration the plugin's `setup` calls, beside the tools: it attaches OpenCode's
 *   credential store to this plugin instance, registers one `bigquery-<alias>` OAuth integration per interactive
 *   account, and registers `/bigquery-doctor` and `/bigquery-signout`.
 *
 * The host is typed structurally (`state.ts`, `AuthContext` below), so this module imports no private host package.
 */
import { DISPLAY_NAME, WRITE_LEVEL_AVAILABLE } from "../constants.js"
import { BigQueryError } from "../domain/errors.js"
import { type Level, type LevelDecision, type Mode, decideLevel, type SignInRecord, SCOPES } from "../domain/levels.js"
import { accountsOf, type AccountOptions, type Options } from "../options.js"
import type { AccessToken, AuthPort, BigQueryPort, Identity } from "../ports.js"
import { createBigQueryPort } from "../process/bigquery.js"
import { type AdcLibrary, loadAdcLibrary } from "./adc-library.js"
import { ADC_SCOPES, adcRefused, adcToken, isManagedHost, type AdcToken } from "./adc.js"
import { clientFromOption, clientRequired, resolveClient, type ClientChoice } from "./client.js"
import { readSignIn, signInClient, signInMetadata, type StoredSignIn } from "./credential.js"
import { runDoctor } from "./doctor.js"
import { integrationIdFor, integrationNames, readAnswer, redirectFor, signInForm, signInScopes } from "./form.js"
import { authorizeGoogle, refreshAccessToken, tokenInfo, type SignInResult } from "./google.js"
import { idTokenIdentity } from "./id-token.js"
import { type DpopKey, readKey, stateDirOf, writeKey } from "./keys.js"
import { checkClientRedirect } from "./redirect.js"
import { canUseBigQuery } from "./scopes.js"
import { signOutLocal } from "./signout.js"
import { activeCredential, attachHost, authState, type AuthHost, type AuthState, answerKey, type CachedToken, forgetAlias, type HostConnection, type HostCredential, reportNeedsSignIn } from "./state.js"

export interface AuthDeps {
  readonly options: Options
  readonly fetch: typeof globalThis.fetch
  /** The ADC library, loaded on first use. */
  readonly adc: typeof loadAdcLibrary
  /** A test's environment, clock and state folder; production uses the process's. */
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly stateDir?: string
}

export type AuthEnv = Omit<AuthDeps, "adc"> & Partial<Pick<AuthDeps, "adc">>

const REFRESH_SKEW_MS = 30_000
const UNAVAILABLE_SIGN_IN = (alias: string) => `No usable Google sign-in for ${alias}`

/** The auth port (src/ports.ts), for one plugin instance. */
export function createAuthPort(deps: AuthEnv): AuthPort {
  return new BigQueryAuth(deps)
}

class BigQueryAuth implements AuthPort {
  private readonly options: Options
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly env: NodeJS.ProcessEnv
  private readonly state: AuthState
  private readonly adcLoader: typeof loadAdcLibrary
  private readonly adcTokens = new Map<string, AdcToken>()

  constructor(deps: AuthEnv) {
    this.options = deps.options
    this.fetch = deps.fetch
    this.now = deps.now ?? Date.now
    this.env = deps.env ?? process.env
    this.state = authState(deps.options, deps.stateDir ?? stateDirOf(this.env))
    this.adcLoader = deps.adc ?? loadAdcLibrary
  }

  accounts(): readonly { readonly alias: string; readonly mode: Mode }[] {
    return Object.entries(accountsOf(this.options)).map(([alias, settings]) => ({ alias, mode: settings.mode }))
  }

  async token(alias: string, signal: AbortSignal): Promise<AccessToken> {
    stopped(signal)
    const settings = this.account(alias)
    switch (settings.mode) {
      case "interactive":
        return this.tokenInteractive(alias, signal)
      case "adc":
        return this.tokenAdc(alias, settings, signal)
      case "token":
        return this.tokenEnv(alias, settings)
    }
  }

  async level(alias: string, signal: AbortSignal): Promise<LevelDecision> {
    stopped(signal)
    const settings = this.account(alias)
    if (settings.mode !== "interactive") {
      return decideLevel({ mode: settings.mode, ...(settings.level !== undefined ? { configured: settings.level } : {}), writeAvailable: WRITE_LEVEL_AVAILABLE })
    }
    const { connection, credential } = await this.active(alias, signal)
    const stored = this.stored(alias, credential)
    const record = stored.record
    const configured = settings.level
    const input = { mode: "interactive" as const, record, ...(configured !== undefined ? { configured } : {}), writeAvailable: WRITE_LEVEL_AVAILABLE }
    // A Read sign-in, a lowered option, an unacknowledged record and a build without writes need no Google call at all.
    if (record.level === "read" || configured === "read" || !record.acknowledged || !WRITE_LEVEL_AVAILABLE) return decideLevel(input)
    // The second check: Google's own answer to this process's latest refresh, never the stored scope string.
    const key = answerKey(alias, record.keyId)
    if (!this.state.refreshed.has(key)) {
      const dpop = readKey(this.state.stateDir, alias, record.keyId)
      if (!dpop) {
        throw new BigQueryError("AUTH_REQUIRED", `The DPoP key for ${alias} is missing, so the sign-in cannot be verified`, `Run /connect and choose ${this.name(alias)} to sign in again.`)
      }
      await this.refreshOnce(alias, stored, credential, dpop, connection, signal)
    }
    return decideLevel({ ...input, refreshedScopes: this.state.refreshed.get(key) ?? [] })
  }

  async identity(alias: string, signal: AbortSignal): Promise<Identity> {
    stopped(signal)
    const settings = this.account(alias)
    if (settings.mode === "interactive") {
      const { credential } = await this.active(alias, signal)
      const stored = this.stored(alias, credential)
      return stored.record.email ? { email: stored.record.email, verified: true } : { verified: false }
    }
    if (settings.mode === "adc") {
      const token = await this.adcFor(alias, settings, signal)
      return token.email ? { email: token.email, verified: token.verified } : { verified: false }
    }
    const value = this.envToken(alias, settings)
    if (!value) return { verified: false }
    const found = await tokenInfo({ token: value, fetch: this.fetch, signal }).catch(() => undefined)
    return found?.email && found.verified ? { email: found.email, verified: true } : { verified: false }
  }

  // ── Interactive ────────────────────────────────────────────────────────

  private async tokenInteractive(alias: string, signal: AbortSignal): Promise<AccessToken> {
    const { connection, credential } = await this.active(alias, signal)
    const stored = this.stored(alias, credential)
    const record = stored.record
    const cached = this.state.tokens.get(alias)
    if (cached && cached.keyId === record.keyId && cached.expiresAt > this.now() + REFRESH_SKEW_MS) {
      this.requireScope(alias, cached.scopes)
      return { token: cached.token, expiresAt: cached.expiresAt, scopes: cached.scopes }
    }
    // Before any Google call: the grant the sign-in's answer recorded must include what BigQuery needs.
    this.requireScope(alias, stored.scopes)
    const key = readKey(this.state.stateDir, alias, record.keyId)
    if (!key) {
      throw new BigQueryError("AUTH_REQUIRED", `The DPoP key for ${alias} is missing, so its sign-in cannot be refreshed`, `Run /connect and choose ${this.name(alias)} to sign in again.`)
    }
    const refreshed = await this.refreshOnce(alias, stored, credential, key, connection, signal)
    return { token: refreshed.token, expiresAt: refreshed.expiresAt, scopes: refreshed.scopes }
  }

  /** One refresh per sign-in in this process, deduplicated; records Google's scope list for the §3.1 second check. */
  private async refreshOnce(alias: string, stored: StoredSignIn, credential: HostCredential, key: DpopKey, connection: HostConnection, signal: AbortSignal): Promise<CachedToken> {
    const record = stored.record
    const keyId = record.keyId
    const id = answerKey(alias, keyId)
    const existing = this.state.inflight.get(id)
    if (existing) return existing
    const running = (async (): Promise<CachedToken> => {
      const refreshToken = this.state.rotated.get(id) ?? credential.refresh
      if (!refreshToken) {
        throw new BigQueryError("AUTH_REQUIRED", UNAVAILABLE_SIGN_IN(alias), `Run /connect and choose ${this.name(alias)} to sign in again.`)
      }
      try {
        const answer = await refreshAccessToken({
          refreshToken,
          client: signInClient(stored).client,
          key,
          ...(this.state.nonces.get(keyId) !== undefined ? { nonce: this.state.nonces.get(keyId) } : {}),
          fetch: this.fetch,
          now: this.now,
          signal,
        })
        if (answer.nonce !== undefined) this.state.nonces.set(keyId, answer.nonce)
        // TODO(L1): confirm whether a refresh answer ever carries a new refresh_token. If it does, the port must persist it
        // through the host (the host callback below already does); this in-memory copy lasts only for this process.
        if (answer.tokens.refresh) this.state.rotated.set(id, answer.tokens.refresh)
        // Google's answer, even when it lists no scope: an empty list is a real answer, and cannot carry the marker.
        this.state.refreshed.set(id, answer.tokens.scopes ?? [])
        const scopes = answer.tokens.scopes && answer.tokens.scopes.length > 0 ? answer.tokens.scopes : stored.scopes
        this.requireScope(alias, scopes)
        const refreshed: CachedToken = { keyId, token: answer.tokens.access, expiresAt: this.now() + answer.tokens.expiresIn * 1000, scopes }
        this.state.tokens.set(alias, refreshed)
        return refreshed
      } catch (error) {
        // A failed refresh leaves no confirmed answer (review L-1): level() must refresh again or refuse, never repeat
        // the last successful scope list as if it were current.
        this.state.tokens.delete(alias)
        this.state.refreshed.delete(id)
        if (error instanceof BigQueryError && error.code === "AUTH_REQUIRED") {
          const host = this.state.host
          if (host) await reportNeedsSignIn(host, integrationIdFor(alias), connection, error.detail)
        }
        throw error
      }
    })().finally(() => {
      this.state.inflight.delete(id)
    })
    this.state.inflight.set(id, running)
    return running
  }

  private requireScope(alias: string, scopes: readonly string[]): void {
    if (canUseBigQuery(scopes)) return
    throw new BigQueryError(
      "AUTH_SCOPE_MISSING",
      `The Google sign-in for ${alias} does not hold the ${SCOPES.bigquery} scope, and Google was not called`,
      "Ask the user to sign in again with /connect and approve every scope listed.",
    )
  }

  private async active(alias: string, signal: AbortSignal): Promise<{ connection: HostConnection; credential: HostCredential }> {
    const host = this.state.host
    if (!host) {
      throw new BigQueryError(
        "AUTH_REQUIRED",
        `OpenCode's credential store is not attached to ${DISPLAY_NAME} for ${alias}`,
        `Run /connect and choose ${this.name(alias)}, or restart OpenCode; if it repeats, report it.`,
      )
    }
    const found = await activeCredential(host, integrationIdFor(alias))
    if (!found) {
      throw new BigQueryError("AUTH_REQUIRED", UNAVAILABLE_SIGN_IN(alias), `Run /connect and choose ${this.name(alias)}, or opencode auth login ${integrationIdFor(alias)}.`)
    }
    stopped(signal)
    return found
  }

  private stored(alias: string, credential: HostCredential): StoredSignIn {
    const stored = readSignIn(credential.metadata)
    if (!stored) {
      throw new BigQueryError("AUTH_REQUIRED", `The stored Google sign-in for ${alias} has no sign-in record`, `Run /connect and choose ${this.name(alias)} to sign in again.`)
    }
    return stored
  }

  // ── Headless ───────────────────────────────────────────────────────────

  private async tokenAdc(alias: string, settings: AccountOptions, signal: AbortSignal): Promise<AccessToken> {
    const token = await this.adcFor(alias, settings, signal)
    return { token: token.token, expiresAt: token.expiresAt, scopes: token.scopes }
  }

  private async adcFor(alias: string, settings: AccountOptions, signal: AbortSignal): Promise<AdcToken> {
    if (!this.options.allowAdcInHost && isManagedHost(this.env)) throw adcRefused(alias)
    const cached = this.adcTokens.get(alias)
    if (cached && cached.expiresAt > this.now() + REFRESH_SKEW_MS) return cached
    stopped(signal)
    const library: AdcLibrary = await this.adcLoader()
    const token = await adcToken({
      library,
      env: this.env,
      now: this.now,
      ...(settings.impersonate !== undefined ? { impersonate: settings.impersonate } : {}),
      scopes: [...ADC_SCOPES, ...(settings.scopes ?? [])],
    })
    stopped(signal)
    this.adcTokens.set(alias, token)
    return token
  }

  private tokenEnv(alias: string, settings: AccountOptions): AccessToken {
    const value = this.envToken(alias, settings)
    if (!value) {
      throw new BigQueryError(
        "AUTH_REQUIRED",
        `The variable ${settings.tokenEnv} of the account ${alias} is empty`,
        `Set ${settings.tokenEnv} in the environment, or sign in interactively with /connect.`,
      )
    }
    // No refresh and no scope list: the token is the person's, and Google reports its scopes only on request.
    return { token: value, expiresAt: this.now() + 60_000, scopes: [] }
  }

  private envToken(alias: string, settings: AccountOptions): string | undefined {
    if (!settings.tokenEnv) {
      throw new BigQueryError("AUTH_REQUIRED", `The account ${alias} is in token mode but names no variable`, `Set accounts.${alias}.tokenEnv to the name of the variable that holds the access token.`)
    }
    const value = this.env[settings.tokenEnv]
    const trimmed = typeof value === "string" ? value.trim() : ""
    return trimmed ? trimmed : undefined
  }

  // ── Names ──────────────────────────────────────────────────────────────

  private account(alias: string): AccountOptions {
    const settings = accountsOf(this.options)[alias]
    if (!settings) throw new BigQueryError("ACCOUNT_UNKNOWN", `No account named ${alias} is configured`, "Pass a configured alias; bigquery_status lists them.")
    return settings
  }

  private name(alias: string): string {
    return integrationNames(accountsOf(this.options)).get(alias) ?? DISPLAY_NAME
  }
}

// ── Host registration ────────────────────────────────────────────────────

interface Registration {
  dispose(): Promise<void>
}

interface IntegrationRef {
  id: string
  name: string
}

interface IntegrationDraft {
  list(): readonly IntegrationRef[]
  get(id: string): IntegrationRef | undefined
  update(id: string, update: (integration: IntegrationRef) => void): void
  readonly method: { update(input: MethodRegistration): void }
}

interface MethodRegistration {
  readonly integrationID: string
  readonly method: { readonly id: string; readonly type: "oauth"; readonly label: string; readonly form: readonly unknown[] }
  readonly authorize: (answer: Record<string, unknown>) => Promise<{ url: string; instructions: string; expiresAt?: number; mode: "auto"; callback: Promise<HostCredential> }>
  readonly refresh: (credential: HostCredential) => Promise<HostCredential>
  readonly label?: (credential: HostCredential) => string | undefined
}

interface CommandEditor {
  add(definition: { readonly name: string; readonly description?: string; readonly execute: (input: { readonly sessionID: string; readonly delivery: "steer" | "queue"; readonly prompt?: { readonly text?: string } }) => Promise<void> }): void
}

interface AuthContext {
  readonly integration: {
    transform(callback: (draft: IntegrationDraft) => void): Promise<Registration>
    readonly connection: {
      active(integrationID: string): Promise<HostConnection | undefined>
      resolve(connection: HostConnection): Promise<HostCredential | undefined>
      status?(input: { readonly integrationID: string; readonly connection: HostConnection; readonly status: { readonly status: "needs_auth"; readonly message: string } | undefined }): Promise<void>
    }
  }
  readonly command: { transform(callback: (editor: CommandEditor) => void): Promise<Registration> }
  readonly session: { synthetic(input: { readonly sessionID: string; readonly delivery: "steer" | "queue"; readonly text: string; readonly description: string; readonly resume: boolean }): Promise<void> }
}

export interface AuthRegistrationEnv extends Omit<AuthEnv, "fetch"> {
  /** `src/plugin.ts` passes `globalThis.fetch`; a test may pass its fake. Omitted, the runtime's own is used. */
  readonly fetch?: typeof globalThis.fetch
  /** A test's port, already built; production builds one from the options. */
  readonly auth?: AuthPort
  readonly bigquery?: BigQueryPort
}

const DOCTOR = { name: "bigquery-doctor", description: `Check each ${DISPLAY_NAME} account's Google access: refresh, dry run, datasets and an IAM check` }
const SIGNOUT = { name: "bigquery-signout", description: "Sign an account out locally: delete its device key, and say what remains in OpenCode" }

/** `/bigquery-doctor` and `/bigquery-signout`, so status and the docs do not spell them twice. */
export const AUTH_COMMANDS = [DOCTOR.name, SIGNOUT.name] as const

/**
 * The host registration: one OAuth integration per interactive account, plus the two commands. Returned to `setup`,
 * which keeps its dispose beside the tools' registration.
 */
export async function registerAuth(ctx: unknown, env: AuthRegistrationEnv): Promise<{ dispose(): Promise<void> }> {
  const context = ctx as AuthContext
  const options = env.options
  const state = authState(options, env.stateDir ?? stateDirOf(env.env ?? process.env))
  const fetch = env.fetch ?? globalThis.fetch
  const now = env.now ?? Date.now
  const auth = env.auth ?? createAuthPort({ ...env, fetch, now })
  const bigquery = env.bigquery ?? createBigQueryPort({ options, auth, fetch })
  const host: AuthHost = {
    active: (integrationID) => context.integration.connection.active(integrationID),
    resolve: (connection) => context.integration.connection.resolve(connection),
    ...(context.integration.connection.status
      ? {
          report: async (integrationID: string, connection: HostConnection, message: string) => {
            await context.integration.connection.status!({ integrationID, connection, status: { status: "needs_auth", message } })
          },
        }
      : {}),
  }
  const detach = attachHost(state, host)
  const registrations: Registration[] = []
  try {
    const interactive = Object.entries(accountsOf(options)).filter(([, settings]) => settings.mode === "interactive")
    if (interactive.length > 0) {
      const names = integrationNames(accountsOf(options))
      registrations.push(
        await context.integration.transform((draft) => {
          for (const [alias, settings] of interactive) {
            const definition = integrationFor({ options, alias, settings, state, host, fetch, now, name: names.get(alias) ?? DISPLAY_NAME })
            draft.update(definition.integrationID, (integration) => {
              integration.name = definition.name
            })
            draft.method.update(definition.registration)
          }
        }),
      )
    }
    registrations.push(
      await context.command.transform((editor) => {
        editor.add({
          name: DOCTOR.name,
          description: DOCTOR.description,
          execute: async ({ sessionID, delivery }) => {
            const answer = await runDoctor({ options, auth, bigquery, signal: new AbortController().signal, now, binding: bindingOf(host) }).catch((error: unknown) => ({
              text: error instanceof BigQueryError ? `${error.code}: ${error.detail}` : `${DISPLAY_NAME} doctor could not run`,
            }))
            await context.session.synthetic({ sessionID, delivery, text: answer.text, description: `${DISPLAY_NAME} doctor`, resume: false })
          },
        })
        editor.add({
          name: SIGNOUT.name,
          description: SIGNOUT.description,
          execute: async (invocation) => {
            const text = await signOut(state, host, options, invocation.prompt?.text ?? "")
            await context.session.synthetic({ sessionID: invocation.sessionID, delivery: invocation.delivery, text, description: `${DISPLAY_NAME} sign-out`, resume: false })
          },
        })
      }),
    )
    return {
      async dispose() {
        detach()
        for (const registration of registrations.splice(0).reverse()) await registration.dispose()
      },
    }
  } catch (cause) {
    detach()
    for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    throw cause
  }
}

/** One interactive account's integration: the form, the browser flow, the refresh callback and the label. */
function integrationFor(input: {
  readonly options: Options
  readonly alias: string
  readonly settings: AccountOptions
  readonly state: AuthState
  readonly host: AuthHost
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly name: string
}): { integrationID: string; name: string; registration: MethodRegistration } {
  const { alias, settings, host, fetch, now, name } = input
  const accountClient = clientFromOption(settings.oauthClient)
  const pluginClient = clientFromOption(input.options.oauthClient)
  const configured = { ...(accountClient ? { account: accountClient } : {}), ...(pluginClient ? { plugin: pluginClient } : {}) }
  const redirectOption = { ...(input.options.redirectUri !== undefined ? { redirectUri: input.options.redirectUri } : {}), ...(input.options.callbackPort !== undefined ? { callbackPort: input.options.callbackPort } : {}) }
  const configuredClient = configured.account ?? configured.plugin
  const integrationID = integrationIdFor(alias)
  const google = { fetch, now }

  const authorize = async (answer: Record<string, unknown>) => {
    const parsed = readAnswer(answer, { configuredClient: configuredClient !== undefined })
    const redirect = redirectFor(parsed, redirectOption)
    const previous = parsed.form ? undefined : await previousClient(host, integrationID)
    const choice = resolveClient({ ...(configured.account ? { account: configured.account } : {}), ...(configured.plugin ? { plugin: configured.plugin } : {}), ...(parsed.form ? { form: parsed.form } : {}), ...(previous ? { previous } : {}) })
    if (!choice) throw clientRequired(alias, name)
    // Throws INPUT_INVALID for a redirect this client would have refused, before the browser opens.
    checkClientRedirect(choice.client, redirect.uri || undefined)
    const previousRecord = await activeCredential(host, integrationID).then((active) => (active ? readSignIn(active.credential.metadata) : undefined))
    const authorization = await authorizeGoogle({ alias, client: choice.client, level: parsed.level, ...(settings.scopes !== undefined ? { extraScopes: settings.scopes } : {}), redirect, options: google })
    return {
      url: authorization.url,
      instructions: authorization.instructions,
      expiresAt: authorization.expiresAt,
      mode: "auto" as const,
      callback: authorization.callback.then((result) => completeSignIn({ alias, level: parsed.level, client: choice, result, state: input.state, now, extraScopes: settings.scopes ?? [], previousKeyId: previousRecord?.record.keyId })),
    }
  }

  return {
    integrationID,
    name,
    registration: {
      integrationID,
      method: { id: "google", type: "oauth", label: "Sign in with Google", form: signInForm(alias, configuredClient, redirectOption, settings.scopes ?? []) },
      authorize,
      refresh: (credential) => refreshSignIn({ alias, name, credential, state: input.state, fetch, now }),
      label: (credential) => readSignIn(credential.metadata)?.record.email ?? alias,
    },
  }
}

/** Builds the credential a completed sign-in leaves in OpenCode's store. Access tokens stay in memory: `access` is empty. */
function completeSignIn(input: { readonly alias: string; readonly level: Level; readonly client: ClientChoice; readonly result: SignInResult; readonly state: AuthState; readonly now: () => number; readonly extraScopes: readonly string[]; readonly previousKeyId?: string }): HostCredential {
  writeKey(input.state.stateDir, input.alias, input.result.key)
  if (input.result.nonce !== undefined) input.state.nonces.set(input.result.key.keyId, input.result.nonce)
  if (input.previousKeyId && input.previousKeyId !== input.result.key.keyId) input.state.nonces.delete(input.previousKeyId)
  forgetAlias(input.state, input.alias)
  // Review L-4: the first status after a Read sign-in runs the IAM check; the sign-in callback cannot (no stored
  // credential yet, and billingProject may be unset).
  if (input.level === "read") input.state.iamPending.add(answerKey(input.alias, input.result.key.keyId))
  const identity = input.result.tokens.idToken ? idTokenIdentity(input.result.tokens.idToken, { clientId: input.client.client.clientId, now: input.now() }) : undefined
  const record: SignInRecord = {
    version: 1,
    level: input.level,
    acknowledged: input.level === "write",
    binding: input.result.binding,
    keyId: input.result.key.keyId,
    ...(identity?.email !== undefined ? { email: identity.email } : {}),
    signedInAt: new Date(input.now()).toISOString(),
  }
  const scopes = input.result.tokens.scopes && input.result.tokens.scopes.length > 0 ? input.result.tokens.scopes : signInScopes(input.level, input.extraScopes)
  const metadata = signInMetadata({ record, client: input.client, scopes })
  return {
    type: "oauth",
    methodID: "google",
    refresh: input.result.tokens.refresh,
    // Design §3.2: access tokens stay in memory. The host stores this record; it holds no bearer token.
    access: "",
    expires: input.now() + input.result.tokens.expiresIn * 1000,
    metadata: metadata as unknown as Record<string, unknown>,
  }
}

/** The host's refresh callback: a DPoP refresh from the credential itself, with the client and key it stored. */
async function refreshSignIn(input: { readonly alias: string; readonly name: string; readonly credential: HostCredential; readonly state: AuthState; readonly fetch: typeof globalThis.fetch; readonly now: () => number }): Promise<HostCredential> {
  const stored = readSignIn(input.credential.metadata)
  if (!stored) {
    throw new BigQueryError("AUTH_REQUIRED", `The stored Google sign-in for ${input.alias} has no sign-in record`, `Run /connect and choose ${input.name} to sign in again.`)
  }
  const key = readKey(input.state.stateDir, input.alias, stored.record.keyId)
  if (!key) {
    throw new BigQueryError("AUTH_REQUIRED", `The DPoP key for ${input.alias} is missing, so its sign-in cannot be refreshed`, `Run /connect and choose ${input.name} to sign in again.`)
  }
  const id = answerKey(input.alias, stored.record.keyId)
  const refreshToken = input.state.rotated.get(id) ?? input.credential.refresh
  if (!refreshToken) {
    throw new BigQueryError("AUTH_REQUIRED", `The Google sign-in for ${input.alias} has no refresh token`, `Run /connect and choose ${input.name} to sign in again.`)
  }
  let answer: Awaited<ReturnType<typeof refreshAccessToken>>
  try {
    answer = await refreshAccessToken({
      refreshToken,
      client: signInClient(stored).client,
      key,
      ...(input.state.nonces.get(stored.record.keyId) !== undefined ? { nonce: input.state.nonces.get(stored.record.keyId) } : {}),
      fetch: input.fetch,
      now: input.now,
    })
  } catch (error) {
    // A failed refresh leaves no confirmed answer (review L-1), here as on the port's path.
    input.state.tokens.delete(input.alias)
    input.state.refreshed.delete(id)
    throw error
  }
  if (answer.nonce !== undefined) input.state.nonces.set(stored.record.keyId, answer.nonce)
  if (answer.tokens.refresh) input.state.rotated.set(id, answer.tokens.refresh)
  input.state.refreshed.set(id, answer.tokens.scopes ?? [])
  const scopes = answer.tokens.scopes && answer.tokens.scopes.length > 0 ? answer.tokens.scopes : stored.scopes
  input.state.tokens.set(input.alias, { keyId: stored.record.keyId, token: answer.tokens.access, expiresAt: input.now() + answer.tokens.expiresIn * 1000, scopes })
  const identity = answer.tokens.idToken ? idTokenIdentity(answer.tokens.idToken, { clientId: signInClient(stored).client.clientId, now: input.now() }) : undefined
  const metadata = identity?.email ? { ...stored, record: { ...stored.record, email: identity.email } } : stored
  return {
    ...input.credential,
    refresh: answer.tokens.refresh ?? input.credential.refresh,
    access: "",
    expires: input.now() + answer.tokens.expiresIn * 1000,
    metadata: metadata as unknown as Record<string, unknown>,
  }
}

async function previousClient(host: AuthHost, integrationID: string): Promise<ClientChoice | undefined> {
  const active = await activeCredential(host, integrationID)
  const stored = active ? readSignIn(active.credential.metadata) : undefined
  return stored ? signInClient(stored) : undefined
}

function bindingOf(host: AuthHost): (alias: string) => Promise<"bound" | "unbound" | undefined> {
  return async (alias) => {
    const active = await activeCredential(host, integrationIdFor(alias))
    return active ? readSignIn(active.credential.metadata)?.record.binding : undefined
  }
}

/** `/bigquery-signout [alias]`: the key is deleted locally; the host's own step deletes the stored token. */
async function signOut(state: AuthState, host: AuthHost, options: Options, text: string): Promise<string> {
  const aliases = Object.keys(accountsOf(options))
  const words = text.trim().split(/\s+/).filter(Boolean)
  const named = words[0]
  const alias = named !== undefined ? named : aliases.length === 1 ? aliases[0]! : undefined
  if (!alias || !aliases.includes(alias)) {
    return aliases.length === 1 ? `No account named ${JSON.stringify(named ?? "")}; the configured account is ${aliases[0]}.` : `Name one of the configured accounts: ${aliases.join(", ")}.`
  }
  const active = await activeCredential(host, integrationIdFor(alias))
  const stored = active ? readSignIn(active.credential.metadata) : undefined
  return signOutLocal({ state, alias, ...(stored ? { binding: stored.record.binding } : {}), connected: active !== undefined }).text
}

function stopped(signal: AbortSignal): void {
  if (signal.aborted) throw new BigQueryError("CANCELLED", "The call was stopped")
}

/** The names a host may show; exported so tests assert the form and URL without importing the form module twice. */
export { integrationIdFor, integrationNames }

/** F's status takes a Read sign-in's pending IAM check once (review L-4). */
export { takePendingIamCheck } from "./state.js"
