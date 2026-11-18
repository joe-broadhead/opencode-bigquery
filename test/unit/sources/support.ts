// Shared scaffolding for package E's tests: the real registry over the Day 0 fakes, and a strict `jobs.list` stand-in
// built from Google's own REST shapes, so a test exercises the handler as a tool call does (account resolution, the
// tool's assert, the guarded ports, the envelope) and nothing reaches the network.
//
// The job fixtures are `bigquery#job` resources as the reference describes them
// (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/list: `jobs[]`, `jobReference`, `state`, `statistics`,
// `configuration`, `status`, `user_email`; https://cloud.google.com/bigquery/docs/reference/rest/v2/Job for the fields),
// and the stand-in filters and pages them the way `jobs.list` documents: `minCreationTime` and `maxCreationTime`
// inclusive, reverse chronological by creation time, `stateFilter` DONE, `pageToken` for the next page. It refuses a
// call the real API would refuse or that this source must not make.
import type { DryRunStatistics, SchemaField, TableInfo, TableReference } from "../../../src/domain/google.js"
import type { Options } from "../../../src/options.js"
import { loadOptions } from "../../../src/options.js"
import type { JobStatus, ResultPage } from "../../../src/ports.js"
import { toolSpecs } from "../../../src/registry.js"
import type { AssertRequest, Call, ToolSpec } from "../../../src/tool-spec.js"
import { FILE_HANDLERS } from "../../../src/handlers/files.js"
import { SOURCE_HANDLERS } from "../../../src/handlers/sources.js"
import { FakeBigQuery, fakePorts, readRecord, type FakeAccount, type FakeAuth, type FakeClock, type FakeLedger } from "../../fake/ports.js"

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

export function harness(extra: Record<string, unknown> = {}, account: FakeAccount = { mode: "interactive", record: readRecord({ email: "ada@example.invalid" }), email: "ada@example.invalid", refreshScopes: [] }): Harness {
  const ports = fakePorts({ [ACCOUNT]: account })
  const options = loadOptions({ accounts: { [ACCOUNT]: { billingProject: PROJECT, location: LOCATION } }, ...extra })
  const specs = toolSpecs(options, ports, { ...SOURCE_HANDLERS, ...FILE_HANDLERS })
  return { ports, options, spec: (name: string) => specs.find((item) => item.name === name)!, bigquery: ports.bigquery, auth: ports.auth, ledger: ports.ledger, clock: ports.clock }
}

export interface CallResult {
  readonly output: Record<string, unknown>
  readonly asserted: AssertRequest[]
}

export function call(options: { via?: Call["via"]; deny?: (request: AssertRequest) => boolean; sessionID?: string; signal?: AbortSignal } = {}): Call & { asserted: AssertRequest[] } {
  const asserted: AssertRequest[] = []
  return {
    sessionID: options.sessionID ?? "ses_sources_1",
    agent: "build",
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
}

/** One tool call through the registry, as the model's tool makes it. */
export async function runTool(target: Harness, name: string, input: unknown, overrides: Parameters<typeof call>[0] = {}): Promise<CallResult> {
  const used = call(overrides)
  const outcome = await target.spec(name).run(input as never, used)
  return { output: outcome.output as Record<string, unknown>, asserted: used.asserted }
}

export const one = <T>(values: readonly T[]): T => {
  if (values.length !== 1) throw new Error(`expected exactly one value, got ${values.length}`)
  return values[0]!
}

// ── a `bigquery#job`, as jobs.list returns it ────────────────────────────

export interface JobFixture {
  readonly jobId: string
  /** Creation time, ms. The listing's only order. */
  readonly created: number
  /** End time, ms: the contract's `occurred_at`. */
  readonly ended: number
  readonly project?: string
  readonly location?: string
  readonly statementType?: string
  readonly bytesBilled?: number
  readonly bytesProcessed?: number
  readonly cacheHit?: boolean
  readonly state?: "DONE" | "RUNNING" | "PENDING"
  readonly labels?: Readonly<Record<string, string>>
  readonly error?: { readonly reason: string; readonly message?: string; readonly location?: string }
  readonly referencedTables?: readonly TableReference[]
  readonly sql?: string
}

/** An invented finished job, with the fields a test cares about. */
export const job = (fields: Partial<JobFixture> & { readonly jobId: string; readonly created: number; readonly ended: number }): JobFixture => ({
  statementType: "SELECT",
  bytesBilled: 1_048_576,
  ...fields,
})

/** One job resource exactly as `jobs.list`'s `jobs[]` carries it (a full-projection answer). */
export function jobResource(job: JobFixture): Record<string, unknown> {
  const projectId = job.project ?? PROJECT
  const location = job.location ?? LOCATION
  const state = job.state ?? "DONE"
  return {
    kind: "bigquery#job",
    etag: `"invented-${job.jobId}"`,
    id: `${projectId}:${location}.${job.jobId}`,
    selfLink: `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/jobs/${job.jobId}?location=${location}`,
    jobReference: { projectId, jobId: job.jobId, location },
    state,
    statistics: {
      creationTime: String(job.created),
      startTime: String(job.created),
      ...(state === "DONE" ? { endTime: String(job.ended) } : {}),
      query: {
        statementType: job.statementType ?? "SELECT",
        ...(job.bytesProcessed !== undefined ? { totalBytesProcessed: String(job.bytesProcessed) } : {}),
        ...(job.bytesBilled !== undefined ? { totalBytesBilled: String(job.bytesBilled) } : {}),
        ...(job.cacheHit !== undefined ? { cacheHit: job.cacheHit } : {}),
        ...(job.referencedTables !== undefined ? { referencedTables: job.referencedTables } : {}),
      },
    },
    configuration: {
      query: { query: job.sql ?? "SELECT 1", useLegacySql: false, priority: "INTERACTIVE" },
      ...(job.labels !== undefined ? { labels: job.labels } : {}),
    },
    status: { state, ...(job.error !== undefined ? { errorResult: job.error } : {}) },
    user_email: "ada@example.invalid",
  }
}

/** The `JobStatus` the runtime makes of one `bigquery#job` (the fields this source reads). */
export function jobStatusOf(resource: Record<string, unknown>): JobStatus {
  const ref = resource["jobReference"] as { projectId: string; jobId: string; location?: string }
  const statistics = resource["statistics"] as Record<string, unknown>
  const query = (statistics["query"] ?? {}) as Record<string, unknown>
  const configuration = (resource["configuration"] ?? {}) as Record<string, unknown>
  const status = (resource["status"] ?? {}) as Record<string, unknown>
  const error = status["errorResult"] as { reason?: string; location?: string; message?: string } | undefined
  const bytes = (value: unknown) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "number" ? value : undefined)
  return {
    ref: { projectId: ref.projectId, jobId: ref.jobId, location: ref.location ?? "" },
    state: (resource["state"] as JobStatus["state"]) ?? "DONE",
    ...(typeof query["statementType"] === "string" ? { statementType: query["statementType"] } : {}),
    ...(bytes(query["totalBytesProcessed"]) !== undefined ? { totalBytesProcessed: bytes(query["totalBytesProcessed"])! } : {}),
    ...(bytes(query["totalBytesBilled"]) !== undefined ? { totalBytesBilled: bytes(query["totalBytesBilled"])! } : {}),
    ...(query["cacheHit"] !== undefined ? { cacheHit: query["cacheHit"] as boolean } : {}),
    ...(Array.isArray(query["referencedTables"]) ? { referencedTables: query["referencedTables"] as TableReference[] } : {}),
    ...(typeof configuration["labels"] === "object" ? { labels: configuration["labels"] as Record<string, string> } : {}),
    ...(bytes(statistics["creationTime"]) !== undefined ? { creationTime: bytes(statistics["creationTime"])! } : {}),
    ...(bytes(statistics["endTime"]) !== undefined ? { endTime: bytes(statistics["endTime"])! } : {}),
    ...(typeof (configuration["query"] as Record<string, unknown> | undefined)?.["query"] === "string" ? { sqlPreview: ((configuration["query"] as Record<string, unknown>)["query"] as string).slice(0, 200) } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

/**
 * Teaches the fake BigQuery port to answer `jobs.list` from these resources, the way the real API does: the creation
 * window is inclusive, the order is newest first by creation time, `stateFilter` picks DONE, RUNNING or PENDING jobs
 * (each fixture's `state`), and `pageToken` names the offset. test/unit/sources/sim.ts is the moving one. `pageSize` simulates a provider page smaller than `maxResults` (as Google may answer).
 */
export function serveJobs(bigquery: FakeBigQuery, jobs: readonly JobFixture[], options: { readonly pageSize?: number; readonly now?: () => number } = {}): void {
  // Google's clock, as each answer's HTTP Date carries it: the fakes' fixed time unless the test moves it.
  const now = options.now ?? (() => Date.parse("2026-11-17T12:00:00Z"))
  const resources = jobs.map(jobResource)
  bigquery.on("listJobs", async (input) => {
    if (input.stateFilter === undefined) throw new Error("jobs.list: this source always names the state it lists")
    if (input.maxResults !== undefined && (input.maxResults < 1 || input.maxResults > 1000)) throw new Error("jobs.list: maxResults out of range")
    if (input.minCreationTime !== undefined && input.maxCreationTime !== undefined && input.minCreationTime > input.maxCreationTime) {
      throw new Error("jobs.list: minCreationTime is after maxCreationTime")
    }
    const matched = resources
      .filter((resource) => String(resource["state"]).toLowerCase() === input.stateFilter)
      .map((resource) => ({ resource, when: Number((resource["statistics"] as { creationTime: string }).creationTime) }))
      .filter((entry) => input.minCreationTime === undefined || entry.when >= input.minCreationTime)
      .filter((entry) => input.maxCreationTime === undefined || entry.when <= input.maxCreationTime)
      .sort((left, right) => right.when - left.when || (String((left.resource["jobReference"] as { jobId: string }).jobId) < String((right.resource["jobReference"] as { jobId: string }).jobId) ? -1 : 1))
      .map((entry) => entry.resource)
    const offset = input.pageToken === undefined ? 0 : Number(input.pageToken)
    if (!Number.isInteger(offset) || offset < 0 || offset > matched.length) throw new Error("jobs.list: unknown pageToken")
    const size = Math.max(1, Math.min(input.maxResults ?? 1000, options.pageSize ?? 1000))
    const slice = matched.slice(offset, offset + size)
    const next = offset + size < matched.length ? String(offset + size) : undefined
    return { items: slice.map(jobStatusOf), ...(next !== undefined ? { nextPageToken: next } : {}), serverTime: now() }
  })
}

// ── Google shapes for the read path, invented ────────────────────────────

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
    schema: { fields: [{ name: "id", type: "INT64" }, { name: "amount", type: "FLOAT64" }] },
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
  return { complete: true, schema: [{ name: "id", type: "INT64" }, { name: "amount", type: "FLOAT64" }], rows: [{ f: [{ v: "1" }, { v: "2.5" }] }], totalRows: 1, ...overrides }
}

/** The happy path of one read over one native table: every probe `prepareRead` makes, answered. */
export function nativeRead(bigquery: FakeBigQuery, input: { statistics?: DryRunStatistics; table?: TableInfo; page?: ResultPage; status?: JobStatus } = {}): void {
  bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: input.statistics ?? statistics() }))
  bigquery.on("getTable", async () => input.table ?? nativeTable())
  bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
  bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
  bigquery.on("run", async () => input.status ?? jobStatus())
  bigquery.on("results", async () => input.page ?? resultPage())
}

export const field = (name: string, type: string, overrides: Partial<SchemaField> = {}): SchemaField => ({ name, type, ...overrides })
