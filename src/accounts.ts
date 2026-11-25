// Accounts: several aliases at once, each a profile in `options.accounts` and its own `<name>-<alias>` integration
// (contract §5). The contract's `accounts` module derives the aliases, validates each profile and registers the
// integration; this file supplies only what is Google's: the OAuth method each alias signs in with.
import { type AccountsRegistration, registerAccounts } from "@we-the-rebel-alliance/plugin-contract/accounts";
import { type AuthContext, authHost, integrationMethod } from "./auth/index.js";
import { manifest } from "./manifest.js";
import type { Options } from "./options.js";

/** The plugin's context as account registration reads it. */
export interface AccountsContext extends AuthContext {
  readonly integration: AuthContext["integration"] & { transform: (callback: (editor: unknown) => void) => Promise<unknown> };
  readonly mcp: { transform: (callback: (editor: unknown) => void) => Promise<unknown> };
}

/** What registering the accounts needs: the context, the options and the runtime's fetch. */
export interface AccountsRequest {
  readonly context: AccountsContext;
  readonly options: Options;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly stateDir?: string;
}

/**
 * Register one integration per configured alias. The transform is cheap, synchronous and never throws; a problem is
 * recorded in the answer for status and never takes the plugin down.
 */
export async function registerPluginAccounts(request: AccountsRequest): Promise<AccountsRegistration> {
  const { context, options } = request;
  const host = authHost(context);
  return registerAccounts(context, {
    manifest,
    options: options as unknown as Record<string, unknown>,
    auth: (account, integrationID) => {
      const settings = options.accounts?.[account.alias] ?? { mode: "interactive" as const };
      const method = integrationMethod({
        options,
        alias: account.alias,
        settings,
        host,
        fetch: request.fetch,
        now: request.now ?? Date.now,
        ...(request.stateDir === undefined ? {} : { stateDir: request.stateDir }),
      });
      return [{ ...method, integrationID }];
    },
  });
}

export type { AccountsRegistration };
