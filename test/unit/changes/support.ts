// Shared scaffolding for package D's unit tests: the real registry over the Day 0 fakes, so every test exercises the
// handler the way a tool call does — account resolution, the tool's own assert, the guarded ports and the envelope.
//
// Every request and response shape below is Google's, with the page that documents it:
// - jobs.insert and the Job resource: https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert and
//   https://cloud.google.com/bigquery/docs/reference/rest/v2/Job (read 18 Nov 2026). `checkDryRun` and `checkRun` refuse
//   a request shape the port could not send, and the DDL/DCL/DML fields of `statistics.query` are the Job page's.
// - tables.get: https://cloud.google.com/bigquery/docs/reference/rest/v2/tables (a native table's `tableReference`,
//   `type`, `numBytes` and `schema`).
// - rowAccessPolicies.list: https://cloud.google.com/bigquery/docs/reference/rest/v2/rowAccessPolicies.
// - jobs.cancel: https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel (`{ kind, job }`).
import { READ_HANDLERS } from "../../../src/handlers/reads.js"
import { CHANGE_HANDLERS } from "../../../src/handlers/changes.js"
import { BigQueryError } from "../../../src/domain/errors.js"
import type { DryRunStatistics, SchemaField, TableInfo, TableReference } from "../../../src/domain/google.js"
import { SCOPES } from "../../../src/domain/levels.js"
import { loadOptions, type Options } from "../../../src/options.js"
import type { JobStatus, ResultPage } from "../../../src/ports.js"
import { toolSpecs } from "../../../src/registry.js"
import type { AssertRequest, Call, ToolSpec } from "../../../src/tool-spec.js"
import { FakeBigQuery, fakePorts, readRecord, writeRecord, type FakeAccount, type FakeAuth, type FakeClock, type FakeLedger } from "../../fake/ports.js"
import type { ChangeStatistics } from "../../../src/changes/statistics.js"

export const ACCOUNT = "default"
export const PROJECT = "invented-proj"
export const LOCATION = "US"
export const DATASET = "sales"
export const TABLE = "orders"
export const OTHER = "invented-proj.sales.other"

export interface Harness {
  readonly ports: ReturnType<typeof fakePorts>
  readonly options: Options
  readonly spec: (name: string) => ToolSpec
  readonly bigquery: FakeBigQuery
  readonly auth: FakeAuth
  readonly ledger: FakeLedger
  readonly clock: FakeClock
}

export function harness(account: FakeAccount = signedIn(), extra: Record<string, unknown> = {}): Harness {
  const ports = fakePorts({ [ACCOUNT]: account })
  const options = loadOptions({ accounts: { [ACCOUNT]: { billingProject: PROJECT, location: LOCATION } }, ...extra })
  const specs = toolSpecs(options, ports, { ...READ_HANDLERS, ...CHANGE_HANDLERS })
  return { ports, options, spec: (name: string) => specs.find((item) => item.name === name)!, bigquery: ports.bigquery, auth: ports.auth, ledger: ports.ledger, clock: ports.clock }
}

/** A Read and write account whose Google refresh answer carries the write marker (design §3.1). */
export const signedIn = (overrides: Partial<FakeAccount> = {}): FakeAccount => ({
  mode: "interactive",
  record: writeRecord(),
  refreshScopes: [SCOPES.bigquery, SCOPES.email, SCOPES.writeMarker],
  ...overrides,
})

/** A Read account: the sign-in record says Read, so no Google call decides the level. */
export const readOnly = (overrides: Partial<FakeAccount> = {}): FakeAccount => ({ mode: "interactive", record: readRecord(), refreshScopes: [SCOPES.bigquery, SCOPES.email], ...overrides })

export interface CallResult {
  readonly output: Record<string, unknown>
  readonly asserted: AssertRequest[]
  readonly call: Call
}

export function call(options: { via?: Call["via"]; deny?: (request: AssertRequest) => boolean; sessionID?: string; agent?: string; signal?: AbortSignal } = {}): Call & { asserted: AssertRequest[] } {
  const asserted: AssertRequest[] = []
  const value = {
    sessionID: options.sessionID ?? "ses_changes_1",
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

// ── Google's request shapes: the port refuses anything else ──────────────

const DRY_RUN_KEYS = ["account", "project", "sql", "params", "defaultDataset", "location", "useQueryCache"]
const RUN_KEYS = [...DRY_RUN_KEYS, "jobId", "maximumBytesBilled", "jobTimeoutMs", "labels"]
/** JobConfigurationQuery fields a change never carries (jobs.insert, JobConfigurationQuery). */
const FORBIDDEN = ["destinationTable", "createSession", "connectionProperties", "writeDisposition", "createDisposition", "scriptOptions"]

function checkKeys(request: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(request).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${what} carries ${unknown.join(", ")}, which Google's jobs.insert body would not`)
  for (const key of ["account", "project", "sql", "useQueryCache"]) {
    if (request[key] === undefined) throw new Error(`${what} is missing ${key}`)
  }
  for (const key of FORBIDDEN) {
    if (request[key] !== undefined) throw new Error(`${what} carries ${key}, which a plugin change must never send`)
  }
}

/** The dry-run request, as Google's jobs.insert with `configuration.dryRun` takes it. */
export function checkDryRun(request: Record<string, unknown>): void {
  checkKeys(request, DRY_RUN_KEYS, "a dry run")
  if (request.useQueryCache !== false) throw new Error("a dry run must not read the query cache, because a cache hit need not list what it read")
  for (const key of ["jobId", "maximumBytesBilled", "jobTimeoutMs", "labels"]) {
    if (request[key] !== undefined) throw new Error(`a dry run does not carry ${key}`)
  }
}

/**
 * The run request: a client job id, the cap, the labels, the time limit and no destination or session. A read the cap
 * cannot bound runs through package C's read path, which may use the query cache (`read: true`); a change never does.
 */
export function checkRun(request: Record<string, unknown>, read = false): void {
  checkKeys(request, RUN_KEYS, "a change run")
  if (typeof request.jobId !== "string" || !/^oc_[A-Za-z0-9-]{1,1024}$/.test(request.jobId)) throw new Error("a run needs a client job id (`oc_<uuid>`)")
  if (typeof request.maximumBytesBilled !== "number" || !Number.isInteger(request.maximumBytesBilled) || request.maximumBytesBilled <= 0) throw new Error("a run needs a positive integer maximumBytesBilled")
  if (typeof request.jobTimeoutMs !== "number" || !Number.isInteger(request.jobTimeoutMs) || request.jobTimeoutMs <= 0) throw new Error("a run needs a positive integer jobTimeoutMs")
  if (typeof request.location !== "string" || request.location === "") throw new Error("a run is pinned to the dry run's location")
  const labels = request.labels as Record<string, string> | undefined
  if (labels === undefined || Object.keys(labels).sort().join(",") !== "oc_plugin,oc_session,oc_tool") throw new Error("a run carries exactly the plugin's three labels")
  if (!read && request.useQueryCache !== false) throw new Error("a change run must not use the query cache")
}

// ── Google shapes, invented, from the pages named at the top ────────────

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

export function statistics(overrides: Partial<ChangeStatistics> = {}): ChangeStatistics {
  return {
    statementType: "INSERT",
    totalBytesProcessed: "1048576",
    totalBytesProcessedAccuracy: "PRECISE",
    referencedTables: [tableRef()],
    schema: { fields: [{ name: "id", type: "INT64" }] },
    ...overrides,
  }
}

/** A job this plugin started: the `oc_` id and the server-side label the cancel ownership check requires. */
export function pluginJob(overrides: Partial<JobStatus> = {}): JobStatus {
  return jobStatus({
    labels: { oc_plugin: "opencode-bigquery", oc_tool: "bigquery_query", oc_session: "0123456789abcdef" },
    ...overrides,
  })
}

export function jobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    ref: { projectId: PROJECT, jobId: "oc_00000000-0000-4000-8000-000000000001", location: LOCATION },
    state: "DONE",
    statementType: "INSERT",
    totalBytesProcessed: 1048576,
    totalBytesBilled: 1048576,
    numDmlAffectedRows: 3,
    cacheHit: false,
    creationTime: Date.parse("2026-11-17T12:00:00Z"),
    endTime: Date.parse("2026-11-17T12:00:01Z"),
    ...overrides,
  }
}

export function resultPage(overrides: Partial<ResultPage> = {}): ResultPage {
  return { complete: true, schema: [{ name: "id", type: "INT64" }], rows: [], totalRows: 0, ...overrides }
}

export function field(name: string, type: string, overrides: Partial<SchemaField> = {}): SchemaField {
  return { name, type, ...overrides }
}

// ── Scripts for the fake port ───────────────────────────────────────────

export interface DryRunScript {
  readonly statistics?: ChangeStatistics
  readonly location?: string
  readonly error?: BigQueryError
}

/** A queue of dry-run answers, checked against the jobs.insert shape; the last one answers every later call. */
export function scriptDryRuns(bigquery: FakeBigQuery, answers: readonly DryRunScript[]): void {
  let index = 0
  bigquery.on("dryRun", async (request) => {
    checkDryRun(request as unknown as Record<string, unknown>)
    const answer = answers[Math.min(index, answers.length - 1)]!
    index += 1
    if (answer.error !== undefined) throw answer.error
    return { location: answer.location ?? LOCATION, ...(answer.statistics !== undefined ? { statistics: answer.statistics } : {}) }
  })
}

/** A dry-run answer chosen by the SQL text, for a script whose statements are dry-run one by one. */
export function scriptDryRunsBySql(bigquery: FakeBigQuery, answerFor: (sql: string) => DryRunScript): void {
  bigquery.on("dryRun", async (request) => {
    checkDryRun(request as unknown as Record<string, unknown>)
    const sql = (request as { readonly sql: string }).sql
    const answer = answerFor(sql)
    if (answer.error !== undefined) throw answer.error
    return { location: answer.location ?? LOCATION, ...(answer.statistics !== undefined ? { statistics: answer.statistics } : {}) }
  })
}

/** One change over one native table: every guard's request answered, its dry run checked, its run checked. */
export function scriptChange(
  bigquery: FakeBigQuery,
  input: {
    dryRuns: readonly DryRunScript[]
    status?: JobStatus
    tables?: Record<string, TableInfo>
    /** A run through package C's read path, where the cache may be used. */
    readRun?: boolean
    run?: (request: Record<string, unknown>) => JobStatus | Promise<JobStatus>
  },
): void {
  scriptDryRuns(bigquery, input.dryRuns)
  bigquery.on("getTable", async (_account: string, ref: TableReference) => input.tables?.[`${ref.projectId}.${ref.datasetId}.${ref.tableId}`] ?? nativeTable({ tableReference: ref }))
  bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
  bigquery.on("listTableData", async () => resultPage())
  bigquery.on("run", async (request) => {
    checkRun(request as unknown as Record<string, unknown>, input.readRun === true)
    return input.run ? await input.run(request as unknown as Record<string, unknown>) : (input.status ?? jobStatus())
  })
  bigquery.on("results", async () => resultPage())
  bigquery.on("getJob", async () => input.status ?? jobStatus())
}

/** A table record with a tagged column, as tables.get answers it (Table page's `schema.fields.policyTags`). */
export function taggedTable(tableId = TABLE): TableInfo {
  return nativeTable({
    tableReference: tableRef(tableId),
    schema: {
      fields: [
        { name: "id", type: "INT64" },
        { name: "ssn", type: "STRING", policyTags: { names: ["projects/invented/locations/US/taxonomies/1/policyTags/2"] } },
      ],
    },
  })
}
