// Shared scaffolding for package F's unit tests: the real registry over the Day 0 fakes, so `bigquery_status` runs the
// way a tool call does — account resolution, its own assert, the guarded ports and the envelope.
import { STATUS_HANDLERS } from "../../../src/handlers/status.js"
import type { Options } from "../../../src/options.js"
import { loadOptions } from "../../../src/options.js"
import { toolSpecs } from "../../../src/registry.js"
import type { AssertRequest, Call, ToolSpec } from "../../../src/tool-spec.js"
import { FakeBigQuery, fakePorts, readRecord, type FakeAccount, type FakeAuth, type FakeClock, type FakeLedger } from "../../fake/ports.js"

export const ACCOUNT = "default"
export const PROJECT = "invented-proj"
export const LOCATION = "US"

export interface Harness {
  readonly ports: ReturnType<typeof fakePorts>
  readonly options: Options
  readonly spec: (name: string) => ToolSpec
  readonly bigquery: FakeBigQuery
  readonly auth: FakeAuth
  readonly ledger: FakeLedger
  readonly clock: FakeClock
}

export function harness(account: FakeAccount = { mode: "interactive", record: readRecord(), refreshScopes: [] }, extra: Record<string, unknown> = {}): Harness {
  const ports = fakePorts({ [ACCOUNT]: account })
  // The options carry the account's mode, as a person's do: one source for both the port and the status.
  const options = loadOptions({ accounts: { [ACCOUNT]: { mode: account.mode, billingProject: PROJECT, location: LOCATION } }, ...extra })
  const specs = toolSpecs(options, ports, STATUS_HANDLERS)
  return { ports, options, spec: (name: string) => specs.find((item) => item.name === name)!, bigquery: ports.bigquery, auth: ports.auth, ledger: ports.ledger, clock: ports.clock }
}

/** Two accounts, for the calls that name none. */
export function twoAccounts(): Harness {
  const ports = fakePorts({
    [ACCOUNT]: { mode: "interactive", record: readRecord(), refreshScopes: [] },
    work: { mode: "interactive", record: readRecord(), refreshScopes: [] },
  })
  const options = loadOptions({ accounts: { [ACCOUNT]: { billingProject: PROJECT, location: LOCATION }, work: { billingProject: "invented-work", location: "EU" } } })
  const specs = toolSpecs(options, ports, STATUS_HANDLERS)
  return { ports, options, spec: (name: string) => specs.find((item) => item.name === name)!, bigquery: ports.bigquery, auth: ports.auth, ledger: ports.ledger, clock: ports.clock }
}

export interface CallResult {
  readonly output: Record<string, unknown>
  readonly asserted: AssertRequest[]
  readonly call: Call
}

export function call(options: { via?: Call["via"]; deny?: (request: AssertRequest) => boolean; sessionID?: string; agent?: string; signal?: AbortSignal } = {}): Call & { asserted: AssertRequest[] } {
  const asserted: AssertRequest[] = []
  const value = {
    sessionID: options.sessionID ?? "ses_status_1",
    agent: options.agent ?? "build",
    messageID: "msg_status_1",
    id: "call_status_1",
    signal: options.signal ?? new AbortController().signal,
    via: options.via ?? "tool",
    async assert(request: AssertRequest) {
      asserted.push(request)
      if (options.deny?.(request)) throw new Error("denied by the rules")
    },
    asserted,
  }
  return value
}

/** One tool call through the registry, as the model's tool makes it. */
export async function runTool(target: Harness, name: string, input: unknown, overrides: Parameters<typeof call>[0] = {}): Promise<CallResult> {
  const used = call(overrides)
  const outcome = await target.spec(name).run(input as never, used)
  return { output: outcome.output as Record<string, unknown>, asserted: used.asserted, call: used }
}

/** The calls a fake port received, by method name. */
export function callsOf(bigquery: FakeBigQuery, method: string): unknown[][] {
  return bigquery.calls.filter((entry) => entry.method === method).map((entry) => [...entry.args])
}
