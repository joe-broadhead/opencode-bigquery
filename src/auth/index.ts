/**
 * The auth port: an access token for an account, its level (write only when both checks of design §3.1 pass), its
 * identity, and the integration method each alias signs in with. DPoP-bound refresh tokens with access tokens in
 * memory, PKCE and the relay, client precedence, and the two modes: `interactive` (OpenCode's credential store) and
 * `token` (a short-lived access token in an environment variable).
 *
 * Two entry points:
 * - `createAuthPort` builds the port the handlers use: `token`, `level`, `identity` and `accounts`.
 * - `integrationMethod` is what the contract's `registerAccounts` registers per alias: one `<name>-<alias>` integration
 *   whose OAuth method is Google's.
 *
 * The host is typed structurally (`state.ts`, `AuthHost`), so this module imports no private host package.
 */

import { accountLabel, accountName } from "@we-the-rebel-alliance/plugin-contract/accounts";
import { WRITE_LEVEL_AVAILABLE } from "../constants.js";
import { BigQueryError } from "../domain/errors.js";
import { decideLevel, type Level, type LevelDecision, type Mode, SCOPES, type SignInRecord } from "../domain/levels.js";
import { type AccountOptions, accountsOf, type Options } from "../options.js";
import type { AccessToken, AuthPort, Identity } from "../ports.js";
import { type ClientChoice, clientFromOption, clientRequired, resolveClient } from "./client.js";
import { readSignIn, type StoredSignIn, signInClient, signInMetadata } from "./credential.js";
import { integrationIdFor, readAnswer, redirectFor, signInForm, signInScopes } from "./form.js";
import { authorizeGoogle, refreshAccessToken, type SignInResult, tokenInfo } from "./google.js";
import { idTokenIdentity } from "./id-token.js";
import { type DpopKey, readKey, stateDirOf, writeKey } from "./keys.js";
import { checkClientRedirect } from "./redirect.js";
import { canUseBigQuery } from "./scopes.js";
import { type AuthHost, type AuthState, activeCredential, answerKey, attachHost, authState, type CachedToken, forgetAlias, type HostConnection, type HostCredential, reportNeedsSignIn } from "./state.js";

export interface AuthDeps {
  readonly options: Options;
  readonly fetch: typeof globalThis.fetch;
  /** A test's environment, clock and state folder; production uses the process's. */
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly stateDir?: string;
}

export type AuthEnv = AuthDeps;

const REFRESH_SKEW_MS = 30_000;
const UNAVAILABLE_SIGN_IN = (alias: string) => `No usable Google sign-in for ${alias}`;

/** The auth port (src/ports.ts), for one plugin instance. */
export function createAuthPort(deps: AuthEnv): AuthPort {
  return new BigQueryAuth(deps);
}

class BigQueryAuth implements AuthPort {
  private readonly options: Options;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly state: AuthState;

  constructor(deps: AuthEnv) {
    this.options = deps.options;
    this.fetch = deps.fetch;
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
    this.state = authState(deps.options, deps.stateDir ?? stateDirOf(this.env));
  }

  accounts(): readonly { readonly alias: string; readonly mode: Mode }[] {
    return Object.entries(accountsOf(this.options)).map(([alias, settings]) => ({ alias, mode: settings.mode }));
  }

  async token(alias: string, signal: AbortSignal): Promise<AccessToken> {
    stopped(signal);
    const settings = this.account(alias);
    if (settings.mode === "token") return this.tokenEnv(alias, settings);
    return this.tokenInteractive(alias, signal);
  }

  async level(alias: string, signal: AbortSignal): Promise<LevelDecision> {
    stopped(signal);
    const settings = this.account(alias);
    if (settings.mode !== "interactive") {
      return decideLevel({ mode: settings.mode, ...(settings.level !== undefined ? { configured: settings.level } : {}), writeAvailable: WRITE_LEVEL_AVAILABLE });
    }
    const { connection, credential } = await this.active(alias, signal);
    const stored = this.stored(alias, credential);
    const record = stored.record;
    const configured = settings.level;
    const input = { mode: "interactive" as const, record, ...(configured !== undefined ? { configured } : {}), writeAvailable: WRITE_LEVEL_AVAILABLE };
    // A Read sign-in, a lowered option, an unacknowledged record and a build without writes need no Google call at all.
    if (record.level === "read" || configured === "read" || !record.acknowledged || !WRITE_LEVEL_AVAILABLE) return decideLevel(input);
    // The second check: Google's own answer to this process's latest refresh, never the stored scope string.
    const key = answerKey(alias, record.keyId);
    if (!this.state.refreshed.has(key)) {
      const dpop = readKey(this.state.stateDir, alias, record.keyId);
      if (!dpop) {
        throw new BigQueryError("AUTH_REQUIRED", `The DPoP key for ${alias} is missing, so the sign-in cannot be verified`, `Run /connect and choose ${this.name(alias)} to sign in again.`);
      }
      await this.refreshOnce(alias, stored, credential, dpop, connection, signal);
    }
    return decideLevel({ ...input, refreshedScopes: this.state.refreshed.get(key) ?? [] });
  }

  async identity(alias: string, signal: AbortSignal): Promise<Identity> {
    stopped(signal);
    const settings = this.account(alias);
    if (settings.mode === "interactive") {
      const { credential } = await this.active(alias, signal);
      const stored = this.stored(alias, credential);
      return stored.record.email ? { email: stored.record.email, verified: true } : { verified: false };
    }
    const value = this.envToken(alias, settings);
    if (!value) return { verified: false };
    const found = await tokenInfo({ token: value, fetch: this.fetch, signal }).catch(() => undefined);
    return found?.email && found.verified ? { email: found.email, verified: true } : { verified: false };
  }

  /** From the active credential's sign-in record, as `bindingOf` reads it; no Google call, and no refusal. */
  async binding(alias: string, signal: AbortSignal): Promise<"bound" | "unbound" | undefined> {
    stopped(signal);
    if (this.account(alias).mode !== "interactive") return undefined;
    const host = this.state.host;
    if (!host) return undefined;
    const active = await activeCredential(host, integrationIdFor(alias));
    return active ? readSignIn(active.credential.metadata)?.record.binding : undefined;
  }

  // ── Interactive ────────────────────────────────────────────────────────

  private async tokenInteractive(alias: string, signal: AbortSignal): Promise<AccessToken> {
    const { connection, credential } = await this.active(alias, signal);
    const stored = this.stored(alias, credential);
    const record = stored.record;
    const cached = this.state.tokens.get(alias);
    if (cached && cached.keyId === record.keyId && cached.expiresAt > this.now() + REFRESH_SKEW_MS) {
      this.requireScope(alias, cached.scopes);
      return { token: cached.token, expiresAt: cached.expiresAt, scopes: cached.scopes };
    }
    // Before any Google call: the grant the sign-in's answer recorded must include what BigQuery needs.
    this.requireScope(alias, stored.scopes);
    const key = readKey(this.state.stateDir, alias, record.keyId);
    if (!key) {
      throw new BigQueryError("AUTH_REQUIRED", `The DPoP key for ${alias} is missing, so its sign-in cannot be refreshed`, `Run /connect and choose ${this.name(alias)} to sign in again.`);
    }
    const refreshed = await this.refreshOnce(alias, stored, credential, key, connection, signal);
    return { token: refreshed.token, expiresAt: refreshed.expiresAt, scopes: refreshed.scopes };
  }

  /** One refresh per sign-in in this process, deduplicated; records Google's scope list for the §3.1 second check. */
  private async refreshOnce(alias: string, stored: StoredSignIn, credential: HostCredential, key: DpopKey, connection: HostConnection, signal: AbortSignal): Promise<CachedToken> {
    const record = stored.record;
    const keyId = record.keyId;
    const id = answerKey(alias, keyId);
    const existing = this.state.inflight.get(id);
    if (existing) return existing;
    const running = (async (): Promise<CachedToken> => {
      const refreshToken = this.state.rotated.get(id) ?? credential.refresh;
      if (!refreshToken) {
        throw new BigQueryError("AUTH_REQUIRED", UNAVAILABLE_SIGN_IN(alias), `Run /connect and choose ${this.name(alias)} to sign in again.`);
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
        });
        if (answer.nonce !== undefined) this.state.nonces.set(keyId, answer.nonce);
        if (answer.tokens.refresh) this.state.rotated.set(id, answer.tokens.refresh);
        // Google's answer, even when it lists no scope: an empty list is a real answer, and cannot carry the marker.
        this.state.refreshed.set(id, answer.tokens.scopes ?? []);
        const scopes = answer.tokens.scopes && answer.tokens.scopes.length > 0 ? answer.tokens.scopes : stored.scopes;
        this.requireScope(alias, scopes);
        const refreshed: CachedToken = { keyId, token: answer.tokens.access, expiresAt: this.now() + answer.tokens.expiresIn * 1000, scopes };
        this.state.tokens.set(alias, refreshed);
        return refreshed;
      } catch (error) {
        // A failed refresh leaves no confirmed answer: level() must refresh again or refuse, never repeat the last
        // successful scope list as if it were current.
        this.state.tokens.delete(alias);
        this.state.refreshed.delete(id);
        if (error instanceof BigQueryError && error.code === "AUTH_REQUIRED") {
          const host = this.state.host;
          if (host) await reportNeedsSignIn(host, integrationIdFor(alias), connection, error.detail);
        }
        throw error;
      }
    })().finally(() => {
      this.state.inflight.delete(id);
    });
    this.state.inflight.set(id, running);
    return running;
  }

  private requireScope(alias: string, scopes: readonly string[]): void {
    if (canUseBigQuery(scopes)) return;
    throw new BigQueryError(
      "AUTH_SCOPE_MISSING",
      `The Google sign-in for ${alias} does not hold the ${SCOPES.bigquery} scope, and Google was not called`,
      "Ask the person to sign in again with /connect and approve every scope listed.",
    );
  }

  private async active(alias: string, signal: AbortSignal): Promise<{ connection: HostConnection; credential: HostCredential }> {
    const host = this.state.host;
    if (!host) {
      throw new BigQueryError("AUTH_REQUIRED", `OpenCode's credential store is not attached to BigQuery for ${alias}`, `Run /connect and choose ${this.name(alias)}, or restart OpenCode; if it repeats, report it.`);
    }
    const found = await activeCredential(host, integrationIdFor(alias));
    if (!found) {
      throw new BigQueryError("AUTH_REQUIRED", UNAVAILABLE_SIGN_IN(alias), `Run /connect and choose ${this.name(alias)}, or opencode auth login ${integrationIdFor(alias)}.`);
    }
    stopped(signal);
    return found;
  }

  private stored(alias: string, credential: HostCredential): StoredSignIn {
    const stored = readSignIn(credential.metadata);
    if (!stored) {
      throw new BigQueryError("AUTH_REQUIRED", `The stored Google sign-in for ${alias} has no sign-in record`, `Run /connect and choose ${this.name(alias)} to sign in again.`);
    }
    return stored;
  }

  // ── Headless ───────────────────────────────────────────────────────────

  private tokenEnv(alias: string, settings: AccountOptions): AccessToken {
    const value = this.envToken(alias, settings);
    if (!value) {
      throw new BigQueryError("AUTH_REQUIRED", `The variable ${settings.tokenEnv} of the account ${alias} is empty`, `Set ${settings.tokenEnv} in the environment, or sign in interactively with /connect.`);
    }
    // No refresh and no scope list: the token is the person's, and Google reports its scopes only on request.
    return { token: value, expiresAt: this.now() + 60_000, scopes: [] };
  }

  private envToken(alias: string, settings: AccountOptions): string | undefined {
    if (!settings.tokenEnv) {
      throw new BigQueryError("AUTH_REQUIRED", `The account ${alias} is in token mode but names no variable`, `Set accounts.${alias}.tokenEnv to the name of the variable that holds the access token.`);
    }
    const value = this.env[settings.tokenEnv];
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? trimmed : undefined;
  }

  // ── Names ──────────────────────────────────────────────────────────────

  private account(alias: string): AccountOptions {
    const settings = accountsOf(this.options)[alias];
    if (!settings) throw new BigQueryError("ACCOUNT_UNKNOWN", `No account named ${alias} is configured`, "Pass a configured alias; the status method lists them.");
    return settings;
  }

  private name(alias: string): string {
    return accountLabel("BigQuery", alias);
  }
}

// ── Host wiring ──────────────────────────────────────────────────────────

/** The part of the plugin context the sign-in host reads. */
export interface AuthContext {
  readonly integration: {
    readonly connection: {
      active(integrationID: string): Promise<HostConnection | undefined>;
      resolve(connection: HostConnection): Promise<HostCredential | undefined>;
      status?(input: { readonly integrationID: string; readonly connection: HostConnection; readonly status: { readonly status: "needs_auth"; readonly message: string } | undefined }): Promise<void>;
    };
  };
}

/** The host as this module reads it, from the plugin's context. */
export function authHost(context: AuthContext): AuthHost {
  return {
    active: (integrationID) => context.integration.connection.active(integrationID),
    resolve: (connection) => context.integration.connection.resolve(connection),
    ...(context.integration.connection.status
      ? {
          report: async (integrationID: string, connection: HostConnection, message: string) => {
            await context.integration.connection.status!({ integrationID, connection, status: { status: "needs_auth", message } });
          },
        }
      : {}),
  };
}

/** Attach the host to the state both the port and the sign-in method share; returns the detach. */
export function attachAuthHost(options: Options, host: AuthHost, stateDir?: string): () => void {
  return attachHost(authState(options, stateDir ?? stateDirOf()), host);
}

/** One alias's integration method: the form, the browser flow, the refresh callback and the label. */
export interface IntegrationRequest {
  readonly options: Options;
  readonly alias: string;
  readonly settings: AccountOptions;
  readonly host: AuthHost;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly stateDir?: string;
}

/** The method registration `registerAccounts` passes to `ctx.integration.transform`. */
export function integrationMethod(input: IntegrationRequest): { integrationID: string; method: Record<string, unknown>; authorize: unknown; refresh: unknown; label: unknown } {
  const { alias, settings, host, fetch, now, options } = input;
  const state = authState(options, input.stateDir ?? stateDirOf());
  const accountClient = clientFromOption(settings.oauthClient);
  const pluginClient = clientFromOption(options.oauthClient);
  const configured = { ...(accountClient ? { account: accountClient } : {}), ...(pluginClient ? { plugin: pluginClient } : {}) };
  const redirectOption = { ...(options.redirectUri !== undefined ? { redirectUri: options.redirectUri } : {}), ...(options.callbackPort !== undefined ? { callbackPort: options.callbackPort } : {}) };
  const configuredClient = accountClient ?? pluginClient;
  const integrationID = integrationIdFor(alias);
  const google = { fetch, now };
  const name = accountLabel("BigQuery", alias);

  const authorize = async (answer: Record<string, unknown>) => {
    const parsed = readAnswer(answer, { configuredClient: configuredClient !== undefined });
    const redirect = redirectFor(parsed, redirectOption);
    const previous = parsed.form ? undefined : await previousClient(host, integrationID);
    const choice = resolveClient({ ...(configured.account ? { account: configured.account } : {}), ...(configured.plugin ? { plugin: configured.plugin } : {}), ...(parsed.form ? { form: parsed.form } : {}), ...(previous ? { previous } : {}) });
    if (!choice) throw clientRequired(alias, name);
    // Throws INPUT_INVALID for a redirect this client would have refused, before the browser opens.
    checkClientRedirect(choice.client, redirect.uri || undefined);
    const previousRecord = await activeCredential(host, integrationID).then((active) => (active ? readSignIn(active.credential.metadata) : undefined));
    const authorization = await authorizeGoogle({ alias, client: choice.client, level: parsed.level, ...(settings.scopes !== undefined ? { extraScopes: settings.scopes } : {}), redirect, options: google });
    return {
      url: authorization.url,
      instructions: authorization.instructions,
      expiresAt: authorization.expiresAt,
      mode: "auto" as const,
      callback: authorization.callback.then((result) => completeSignIn({ alias, level: parsed.level, client: choice, result, state, now, extraScopes: settings.scopes ?? [], previousKeyId: previousRecord?.record.keyId })),
    };
  };

  return {
    integrationID,
    method: { id: "google", type: "oauth", label: "Sign in with Google", form: signInForm(alias, configuredClient, redirectOption, settings.scopes ?? []) },
    authorize,
    refresh: (credential: HostCredential) => refreshSignIn({ alias, name, credential, state, fetch, now }),
    label: (credential: HostCredential) => readSignIn(credential.metadata)?.record.email ?? alias,
  };
}

/** Builds the credential a completed sign-in leaves in OpenCode's store. Access tokens stay in memory: `access` is empty. */
function completeSignIn(input: { readonly alias: string; readonly level: Level; readonly client: ClientChoice; readonly result: SignInResult; readonly state: AuthState; readonly now: () => number; readonly extraScopes: readonly string[]; readonly previousKeyId?: string }): HostCredential {
  writeKey(input.state.stateDir, input.alias, input.result.key);
  if (input.result.nonce !== undefined) input.state.nonces.set(input.result.key.keyId, input.result.nonce);
  if (input.previousKeyId && input.previousKeyId !== input.result.key.keyId) input.state.nonces.delete(input.previousKeyId);
  forgetAlias(input.state, input.alias);
  const identity = input.result.tokens.idToken ? idTokenIdentity(input.result.tokens.idToken, { clientId: input.client.client.clientId, now: input.now() }) : undefined;
  const record: SignInRecord = {
    version: 1,
    level: input.level,
    acknowledged: input.level === "write",
    binding: input.result.binding,
    keyId: input.result.key.keyId,
    ...(identity?.email !== undefined ? { email: identity.email } : {}),
    signedInAt: new Date(input.now()).toISOString(),
  };
  const scopes = input.result.tokens.scopes && input.result.tokens.scopes.length > 0 ? input.result.tokens.scopes : signInScopes(input.level, input.extraScopes);
  const metadata = signInMetadata({ record, client: input.client, scopes });
  return {
    type: "oauth",
    methodID: "google",
    refresh: input.result.tokens.refresh,
    // Design §3.2: access tokens stay in memory. The host stores this record; it holds no bearer token.
    access: "",
    expires: input.now() + input.result.tokens.expiresIn * 1000,
    metadata: metadata as unknown as Record<string, unknown>,
  };
}

/** The host's refresh callback: a DPoP refresh from the credential itself, with the client and key it stored. */
async function refreshSignIn(input: { readonly alias: string; readonly name: string; readonly credential: HostCredential; readonly state: AuthState; readonly fetch: typeof globalThis.fetch; readonly now: () => number }): Promise<HostCredential> {
  const stored = readSignIn(input.credential.metadata);
  if (!stored) {
    throw new BigQueryError("AUTH_REQUIRED", `The stored Google sign-in for ${input.alias} has no sign-in record`, `Run /connect and choose ${input.name} to sign in again.`);
  }
  const key = readKey(input.state.stateDir, input.alias, stored.record.keyId);
  if (!key) {
    throw new BigQueryError("AUTH_REQUIRED", `The DPoP key for ${input.alias} is missing, so its sign-in cannot be refreshed`, `Run /connect and choose ${input.name} to sign in again.`);
  }
  const id = answerKey(input.alias, stored.record.keyId);
  const refreshToken = input.state.rotated.get(id) ?? input.credential.refresh;
  if (!refreshToken) {
    throw new BigQueryError("AUTH_REQUIRED", `The Google sign-in for ${input.alias} has no refresh token`, `Run /connect and choose ${input.name} to sign in again.`);
  }
  let answer: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    answer = await refreshAccessToken({
      refreshToken,
      client: signInClient(stored).client,
      key,
      ...(input.state.nonces.get(stored.record.keyId) !== undefined ? { nonce: input.state.nonces.get(stored.record.keyId) } : {}),
      fetch: input.fetch,
      now: input.now,
    });
  } catch (error) {
    // A failed refresh leaves no confirmed answer, here as on the port's path.
    input.state.tokens.delete(input.alias);
    input.state.refreshed.delete(id);
    throw error;
  }
  if (answer.nonce !== undefined) input.state.nonces.set(stored.record.keyId, answer.nonce);
  if (answer.tokens.refresh) input.state.rotated.set(id, answer.tokens.refresh);
  input.state.refreshed.set(id, answer.tokens.scopes ?? []);
  const scopes = answer.tokens.scopes && answer.tokens.scopes.length > 0 ? answer.tokens.scopes : stored.scopes;
  input.state.tokens.set(input.alias, { keyId: stored.record.keyId, token: answer.tokens.access, expiresAt: input.now() + answer.tokens.expiresIn * 1000, scopes });
  const identity = answer.tokens.idToken ? idTokenIdentity(answer.tokens.idToken, { clientId: signInClient(stored).client.clientId, now: input.now() }) : undefined;
  const metadata = identity?.email ? { ...stored, record: { ...stored.record, email: identity.email } } : stored;
  return {
    ...input.credential,
    refresh: answer.tokens.refresh ?? input.credential.refresh,
    access: "",
    expires: input.now() + answer.tokens.expiresIn * 1000,
    metadata: metadata as unknown as Record<string, unknown>,
  };
}

async function previousClient(host: AuthHost, integrationID: string): Promise<ClientChoice | undefined> {
  const active = await activeCredential(host, integrationID);
  const stored = active ? readSignIn(active.credential.metadata) : undefined;
  return stored ? signInClient(stored) : undefined;
}

function stopped(signal: AbortSignal): void {
  if (signal.aborted) throw new BigQueryError("CANCELLED", "The call was stopped");
}

/** The names a host may show; exported so tests assert the form and URL without importing the form module twice. */
export { integrationIdFor, accountName };
