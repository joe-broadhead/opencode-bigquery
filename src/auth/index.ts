// Package A: the auth port (design §3): the two-level sign-in with the disclosure, the write binding of §3.1
// (decideLevel in src/domain/levels.ts), DPoP-bound refresh tokens with access tokens in memory, PKCE and the relay,
// client precedence, session-control mapping, ADC (src/auth/adc-library.ts) and token modes. Day 0 wires the unbuilt
// port, keeping the account list, which the options already know. `level` passes WRITE_LEVEL_AVAILABLE (src/constants.ts)
// to decideLevel as `writeAvailable`; it only reads that constant.
import { accountsOf, type Options } from "../options.js"
import type { AuthPort } from "../ports.js"
import { unbuilt } from "../unbuilt.js"
import { loadAdcLibrary } from "./adc-library.js"

export interface AuthDeps {
  readonly options: Options
  readonly fetch: typeof globalThis.fetch
  /** The ADC library, loaded on first use. */
  readonly adc: typeof loadAdcLibrary
}

export function createAuthPort(deps: Omit<AuthDeps, "adc"> & Partial<Pick<AuthDeps, "adc">>): AuthPort {
  const accounts = Object.entries(accountsOf(deps.options)).map(([alias, settings]) => ({ alias, mode: settings.mode }))
  const adc = deps.adc ?? loadAdcLibrary
  return unbuilt<AuthPort>("auth", { accounts: () => accounts, adcLibrary: adc } as Partial<AuthPort>)
}
