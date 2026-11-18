/**
 * A fake for every port (src/ports.ts), so each package tests against the contract without the others. Every fake
 * records its calls. Nothing here reaches the network.
 *
 * - `FakeBigQuery`: answers each method from a handler a test sets (`on`), and refuses an unscripted call loudly.
 * - `FakeAuth`: accounts with a stored sign-in record and the scopes the fake token endpoint's refresh returns; `level`
 *   runs the real `decideLevel`, so the levels tests exercise the contract itself. It has no revoke at all.
 * - `FakeLedger`: an in-memory spend ledger.
 * - `FakeClock`: a fixed, steppable clock and counting ids.
 * The plan store needs no fake: `PlanStore` is in-memory; pass it the fake clock.
 */
import { decideLevel, type Level, type Mode, type SignInRecord } from "../../src/domain/levels.js"
import { PlanStore } from "../../src/domain/plans.js"
import type { AccessToken, AuthPort, BigQueryPort, Clock, Identity, LedgerPort, Ports, SpendEntry } from "../../src/ports.js"

export type Call = { readonly method: string; readonly args: readonly unknown[] }

type Method = keyof BigQueryPort
type Impl = (...args: never[]) => unknown

export class FakeBigQuery implements BigQueryPort {
  readonly calls: Call[] = []
  private readonly handlers = new Map<Method, Impl>()

  /** Answers `method` with `impl` from now on. */
  on<M extends Method>(method: M, impl: BigQueryPort[M]): this {
    this.handlers.set(method, impl as Impl)
    return this
  }

  private answer(method: Method, args: unknown[]): Promise<never> {
    this.calls.push({ method, args })
    const impl = this.handlers.get(method)
    if (!impl) return Promise.reject(new Error(`FakeBigQuery: ${method} was called but the test did not script it`))
    return Promise.resolve((impl as (...rest: unknown[]) => never)(...args))
  }

  dryRun = (...args: Parameters<BigQueryPort["dryRun"]>) => this.answer("dryRun", args)
  estimate = (...args: Parameters<BigQueryPort["estimate"]>) => this.answer("estimate", args)
  run = (...args: Parameters<BigQueryPort["run"]>) => this.answer("run", args)
  results = (...args: Parameters<BigQueryPort["results"]>) => this.answer("results", args)
  getJob = (...args: Parameters<BigQueryPort["getJob"]>) => this.answer("getJob", args)
  listJobs = (...args: Parameters<BigQueryPort["listJobs"]>) => this.answer("listJobs", args)
  cancel = (...args: Parameters<BigQueryPort["cancel"]>) => this.answer("cancel", args)
  listProjects = (...args: Parameters<BigQueryPort["listProjects"]>) => this.answer("listProjects", args)
  listDatasets = (...args: Parameters<BigQueryPort["listDatasets"]>) => this.answer("listDatasets", args)
  listTables = (...args: Parameters<BigQueryPort["listTables"]>) => this.answer("listTables", args)
  getTable = (...args: Parameters<BigQueryPort["getTable"]>) => this.answer("getTable", args)
  listTableData = (...args: Parameters<BigQueryPort["listTableData"]>) => this.answer("listTableData", args)
  listRoutines = (...args: Parameters<BigQueryPort["listRoutines"]>) => this.answer("listRoutines", args)
  getRoutine = (...args: Parameters<BigQueryPort["getRoutine"]>) => this.answer("getRoutine", args)
  listRowAccessPolicies = (...args: Parameters<BigQueryPort["listRowAccessPolicies"]>) => this.answer("listRowAccessPolicies", args)
  testTablePermissions = (...args: Parameters<BigQueryPort["testTablePermissions"]>) => this.answer("testTablePermissions", args)
}

export interface FakeAccount {
  readonly mode: Mode
  /** The stored sign-in record: what the plugin's sign-in method wrote, or what a test edits it to. */
  record?: SignInRecord
  /** The scope list the fake token endpoint returns on a refresh. */
  refreshScopes: readonly string[]
  /** The account's `level` option. */
  configured?: Level
  email?: string
}

export class FakeAuth implements AuthPort {
  readonly calls: Call[] = []
  /** How many refreshes the fake token endpoint answered, per account. */
  readonly refreshes = new Map<string, number>()
  private readonly refreshed = new Map<string, readonly string[]>()

  constructor(
    readonly accountsByAlias: Record<string, FakeAccount>,
    /** False while the release ships with the write level off. */
    readonly writeAvailable = true,
  ) {}

  private account(alias: string): FakeAccount {
    const found = this.accountsByAlias[alias]
    if (!found) throw new Error(`FakeAuth: no account ${alias}`)
    return found
  }

  /** The fake token endpoint: a refresh answers the account's current `refreshScopes`. */
  private refresh(alias: string): readonly string[] {
    const scopes = [...this.account(alias).refreshScopes]
    this.refreshed.set(alias, scopes)
    this.refreshes.set(alias, (this.refreshes.get(alias) ?? 0) + 1)
    return scopes
  }

  async token(alias: string, _signal: AbortSignal): Promise<AccessToken> {
    this.calls.push({ method: "token", args: [alias] })
    // A token account has no refresh, so its scopes are unknown: empty (src/ports.ts AccessToken.scopes).
    if (this.account(alias).mode === "token") return { token: `invented-access-token-${alias}`, expiresAt: Date.now() + 3_600_000, scopes: [] }
    const scopes = this.refreshed.get(alias) ?? this.refresh(alias)
    return { token: `invented-access-token-${alias}`, expiresAt: Date.now() + 3_600_000, scopes }
  }

  async level(alias: string, _signal: AbortSignal) {
    this.calls.push({ method: "level", args: [alias] })
    const account = this.account(alias)
    const refreshedScopes = account.mode === "interactive" && account.record?.level === "write" ? (this.refreshed.get(alias) ?? this.refresh(alias)) : this.refreshed.get(alias)
    return decideLevel({
      mode: account.mode,
      ...(account.record ? { record: account.record } : {}),
      ...(refreshedScopes ? { refreshedScopes } : {}),
      ...(account.configured ? { configured: account.configured } : {}),
      writeAvailable: this.writeAvailable,
    })
  }

  async identity(alias: string, _signal: AbortSignal): Promise<Identity> {
    this.calls.push({ method: "identity", args: [alias] })
    const account = this.account(alias)
    return account.email ? { email: account.email, verified: true } : { verified: false }
  }

  async binding(alias: string, _signal: AbortSignal): Promise<"bound" | "unbound" | undefined> {
    this.calls.push({ method: "binding", args: [alias] })
    const account = this.account(alias)
    return account.mode === "interactive" ? account.record?.binding : undefined
  }

  accounts() {
    return Object.entries(this.accountsByAlias).map(([alias, account]) => ({ alias, mode: account.mode }))
  }

  /** A new process: the in-memory refresh answers are gone. */
  restart(): void {
    this.refreshed.clear()
  }
}

export class FakeLedger implements LedgerPort {
  readonly entries: SpendEntry[] = []

  async record(entry: SpendEntry): Promise<void> {
    this.entries.push(entry)
  }

  async spent(query: { readonly account: string; readonly since: number; readonly session?: string }): Promise<number> {
    return this.entries
      .filter((entry) => entry.account === query.account && Date.parse(entry.at) >= query.since && (query.session === undefined || entry.session === query.session))
      .reduce((sum, entry) => sum + entry.bytesBilled, 0)
  }
}

export class FakeClock implements Clock {
  private ids = 0
  constructor(public time = Date.parse("2026-11-17T12:00:00Z")) {}
  now(): number {
    return this.time
  }
  uuid(): string {
    return `00000000-0000-4000-8000-${String(++this.ids).padStart(12, "0")}`
  }
  advance(ms: number): void {
    this.time += ms
  }
}

/** An invented Read and write sign-in record. */
export function writeRecord(overrides: Partial<SignInRecord> = {}): SignInRecord {
  return { version: 1, level: "write", acknowledged: true, binding: "bound", keyId: "key-invented-1", email: "ada@example.invalid", signedInAt: "2026-11-17T11:00:00Z", ...overrides }
}

/** An invented Read sign-in record. */
export function readRecord(overrides: Partial<SignInRecord> = {}): SignInRecord {
  return writeRecord({ level: "read", acknowledged: false, ...overrides })
}

/** Every port, faked. */
export function fakePorts(accounts: Record<string, FakeAccount> = { default: { mode: "interactive", record: readRecord(), refreshScopes: [] } }) {
  const clock = new FakeClock()
  const ports = { bigquery: new FakeBigQuery(), auth: new FakeAuth(accounts), ledger: new FakeLedger(), plans: new PlanStore(() => clock.now()), clock }
  return ports satisfies Ports
}
