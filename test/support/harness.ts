// The test harness: the plugin's real provider client over the fake Google hosts, a test auth port with two synthetic
// accounts, an in-memory ledger, a fixed clock, and the parsed options. Handlers are called the way the register calls
// them (the resolved account, a signal, a bus and, for a commit, the plan).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AccountProfile, accountsOf } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { Bus } from "@we-the-rebel-alliance/plugin-contract/bus"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { createAuthPort } from "../../src/auth/index.js"
import { createHandlers } from "../../src/handlers/index.js"
import { manifest as installed, version } from "../../src/manifest.js"
import { loadOptions, type Options } from "../../src/options.js"
import type { AuthPort, Ports } from "../../src/ports.js"
import { createProvider } from "../../src/provider/index.js"
import { type FakeGoogle, fakeGoogle } from "./google.js"
import { testClock } from "./time.js"

/** The two synthetic aliases: a work account and a personal one, both at the write level. */
export const ALIASES = ["work", "personal"] as const

/** An auth port for the two aliases: a token, the write level, an identity and the device binding. */
class TestAuth implements AuthPort {
  readonly signedIn: Set<string>
  constructor(aliases: readonly string[]) {
    this.signedIn = new Set(aliases)
  }
  private check(alias: string): void {
    if (!this.signedIn.has(alias)) throw Object.assign(new Error(`NEEDS_SIGN_IN: ${alias} is not signed in. Next step: sign in again.`), { code: "AUTH_REQUIRED", detail: `${alias} is not signed in`, next: "Sign in again." })
  }
  async token(alias: string): Promise<{ token: string; expiresAt: number; scopes: readonly string[] }> {
    this.check(alias)
    return { token: `test-token-${alias}`, expiresAt: Date.now() + 3_600_000, scopes: ["https://www.googleapis.com/auth/bigquery", "https://www.googleapis.com/auth/bigquery.insertdata"] }
  }
  async level(alias: string): Promise<{ level: "write" }> {
    this.check(alias)
    return { level: "write" }
  }
  async identity(alias: string): Promise<{ verified: boolean }> {
    this.check(alias)
    // No address: the contract's owner is the account's own scheme-qualified id, and the fixture carries no personal data.
    return { verified: false }
  }
  async binding(): Promise<"bound"> {
    return "bound"
  }
  accounts(): readonly { alias: string; mode: "interactive" }[] {
    return [...this.signedIn].map((alias) => ({ alias, mode: "interactive" as const }))
  }
}

/** One bus emission, as a test reads it. */
export interface Emission {
  readonly event: string
  readonly data: Record<string, unknown>
}

/** A bus that records what a handler emits. */
export function testBus(emissions: Emission[] = []): Bus {
  return {
    name: "bigquery",
    async emit(event, data) {
      emissions.push({ event, data: data as Record<string, unknown> })
      return { ok: true }
    },
  } as Bus
}

/** The call every handler receives from the register, with a commit's plan when one is given. */
export function testCall(account: string, options: { plan?: unknown; bus?: Bus; signal?: AbortSignal } = {}) {
  return {
    sessionID: "ses_test",
    agent: "build",
    messageID: "msg_test",
    id: "call_test",
    account,
    signal: options.signal ?? new AbortController().signal,
    progress: async () => undefined,
    bus: options.bus ?? testBus(),
    unguardedAgents: async () => ({ ok: true as const, agents: [] }),
    door: "tool" as const,
    ...(options.plan === undefined ? {} : { plan: options.plan }),
  }
}

export interface Harness {
  readonly manifest: Manifest
  readonly options: Options
  readonly ports: Ports
  readonly auth: TestAuth
  readonly google: FakeGoogle
  readonly handlers: ReturnType<typeof createHandlers>
  readonly profiles: readonly AccountProfile[]
  readonly emissions: Emission[]
  readonly accountProblems: string[]
}

/** The plugin's parts, with the provider client over the fake hosts. */
export function harness(raw: Record<string, unknown> = {}): Harness {
  const google = fakeGoogle()
  const base: Record<string, unknown> = { accounts: { work: { billingProject: "alpha-analytics" }, personal: { billingProject: "alpha-analytics" } }, savedQueries: { revenue: { sql: "SELECT order_date, total FROM `alpha-analytics.sales.orders` ORDER BY order_date" } }, ...raw }
  const options = loadOptions(base)
  const auth = new TestAuth(ALIASES)
  const clock = testClock()
  const stateDir = mkdtempSync(join(tmpdir(), "bigquery-ledger-"))
  const ports = createProvider({ options, auth, fetch: google.fetch, clock, stateDir })
  const emissions: Emission[] = []
  const accountProblems: string[] = []
  const handlers = createHandlers({ manifest: installed, ports, options, version, hostVersion: "2.4.1", accountProblems })
  const plan = accountsOf(installed, base as Record<string, unknown>)
  return { manifest: installed, options, ports, auth, google, handlers, profiles: plan.ok ? plan.value.accounts : [], emissions, accountProblems }
}
