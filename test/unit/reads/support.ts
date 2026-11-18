// Shared scaffolding for package C's unit tests: the real registry over the Day 0 fakes, so every test exercises the
// handler the way a tool call does — account resolution, the tool's own assert, the guarded ports and the envelope.
import { READ_HANDLERS } from "../../../src/handlers/reads.js"
import type { DryRunStatistics, RoutineInfo, SchemaField, TableInfo, TableReference } from "../../../src/domain/google.js"
import type { Options } from "../../../src/options.js"
import { loadOptions } from "../../../src/options.js"
import type { JobStatus, ResultPage } from "../../../src/ports.js"
import { toolSpecs } from "../../../src/registry.js"
import type { AssertRequest, Call, ToolSpec } from "../../../src/tool-spec.js"
import { FakeBigQuery, fakePorts, readRecord, writeRecord, type FakeAccount, type FakeAuth, type FakeClock, type FakeLedger } from "../../fake/ports.js"

export const ACCOUNT = "default"
export const PROJECT = "invented-proj"
export const LOCATION = "US"
export const DATASET = "sales"
export const TABLE = "orders"

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
  const options = loadOptions({ accounts: { [ACCOUNT]: { billingProject: PROJECT, location: LOCATION } }, ...extra })
  const specs = toolSpecs(options, ports, READ_HANDLERS)
  return { ports, options, spec: (name: string) => specs.find((item) => item.name === name)!, bigquery: ports.bigquery, auth: ports.auth, ledger: ports.ledger, clock: ports.clock }
}

export function optionsOf(extra: Record<string, unknown> = {}): Options {
  return loadOptions({ accounts: { [ACCOUNT]: { billingProject: PROJECT, location: LOCATION } }, ...extra })
}

export interface CallResult {
  readonly output: Record<string, unknown>
  readonly asserted: AssertRequest[]
  readonly call: Call
}

export function call(options: { via?: Call["via"]; deny?: (request: AssertRequest) => boolean; sessionID?: string; agent?: string; signal?: AbortSignal } = {}): Call & { asserted: AssertRequest[] } {
  const asserted: AssertRequest[] = []
  const value = {
    sessionID: options.sessionID ?? "ses_reads_1",
    agent: options.agent ?? "build",
    messageID: "msg_1",
    id: "call_1",
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

export const one = <T>(values: readonly T[]): T => {
  if (values.length !== 1) throw new Error(`expected exactly one value, got ${values.length}`)
  return values[0]!
}

// ── Google shapes, invented ──────────────────────────────────────────────

export function tableRef(tableId = TABLE, datasetId = DATASET, projectId = PROJECT): TableReference {
  return { projectId, datasetId, tableId }
}

export function nativeTable(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    tableReference: tableRef(),
    type: "TABLE",
    location: LOCATION,
    numBytes: "1048576",
    numRows: "100",
    lastModifiedTime: String(Date.parse("2026-11-17T10:00:00Z")),
    schema: { fields: [{ name: "id", type: "INT64", mode: "REQUIRED" }, { name: "amount", type: "FLOAT64" }] },
    ...overrides,
  }
}

export function statistics(overrides: Partial<DryRunStatistics> = {}): DryRunStatistics {
  return {
    statementType: "SELECT",
    totalBytesProcessed: "1048576",
    totalBytesProcessedAccuracy: "PRECISE",
    referencedTables: [tableRef()],
    schema: { fields: [{ name: "id", type: "INT64" }] },
    ...overrides,
  }
}

export function jobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    ref: { projectId: PROJECT, jobId: "oc_00000000-0000-4000-8000-000000000001", location: LOCATION },
    state: "DONE",
    statementType: "SELECT",
    totalBytesProcessed: 1048576,
    totalBytesBilled: 1048576,
    cacheHit: false,
    creationTime: Date.parse("2026-11-17T12:00:00Z"),
    endTime: Date.parse("2026-11-17T12:00:01Z"),
    ...overrides,
  }
}

export function resultPage(overrides: Partial<ResultPage> = {}): ResultPage {
  return {
    complete: true,
    schema: [{ name: "id", type: "INT64" }],
    rows: [{ f: [{ v: "1" }] }, { f: [{ v: "2" }] }],
    totalRows: 2,
    ...overrides,
  }
}

export function routine(overrides: Partial<RoutineInfo> = {}): RoutineInfo {
  return { routineReference: { projectId: PROJECT, datasetId: DATASET, routineId: "fn" }, routineType: "SCALAR_FUNCTION", language: "SQL", ...overrides }
}

export function field(name: string, type: string, overrides: Partial<SchemaField> = {}): SchemaField {
  return { name, type, ...overrides }
}

/** The happy path of one read over one native table: every probe the guards make, answered. */
export function scriptNativeRead(
  bigquery: FakeBigQuery,
  input: { statistics?: DryRunStatistics; table?: TableInfo; page?: ResultPage; status?: JobStatus; tables?: Record<string, TableInfo> } = {},
): void {
  bigquery.on("dryRun", async (request: { sql: string }) => {
    const key = /FROM `([^`]+)`/.exec(request.sql)?.[1]
    if (key && input.tables?.[key]) return { location: LOCATION, statistics: statistics({ referencedTables: [tableRef(key.split(".")[2]!, key.split(".")[1]!, key.split(".")[0]!)] }) }
    return { location: LOCATION, statistics: input.statistics ?? statistics() }
  })
  bigquery.on("getTable", async (_account: string, ref: TableReference) => input.tables?.[`${ref.projectId}.${ref.datasetId}.${ref.tableId}`] ?? input.table ?? nativeTable())
  bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
  bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
  bigquery.on("run", async () => input.status ?? jobStatus())
  bigquery.on("results", async () => input.page ?? resultPage())
}

/** A Read and write record, for a test that only needs the account to be signed in. */
export const signedIn = (overrides: Partial<FakeAccount> = {}): FakeAccount => ({ mode: "interactive", record: writeRecord(), refreshScopes: ["https://www.googleapis.com/auth/bigquery"], ...overrides })
