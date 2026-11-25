/**
 * Google's JSON resources as the port's domain types, and the numbers inside them. Only the fields the plugin uses are
 * declared; each is one of these pages:
 * - the Job resource, `jobReference`, `configuration`, `statistics.query` and `status`:
 *   https://cloud.google.com/bigquery/docs/reference/rest/v2/Job
 * - `jobs.getQueryResults`' answer: https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults
 * - `tabledata.list`' answer: https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/list
 * - the Table resource: https://cloud.google.com/bigquery/docs/reference/rest/v2/tables
 * - the Routine resource: https://cloud.google.com/bigquery/docs/reference/rest/v2/routines
 * - `projects.list`, `datasets.list`: https://cloud.google.com/bigquery/docs/reference/rest/v2/projects/list and
 *   …/datasets/list
 * - `rowAccessPolicies.list`: https://cloud.google.com/bigquery/docs/reference/rest/v2/rowAccessPolicies/list
 *
 * Google sends int64 fields as strings; they become numbers here, because every byte count and row count the plugin
 * compares is far below 2^53, and a string would make the cap arithmetic wrong.
 */
import { BigQueryError } from "../domain/errors.js"
import type { DatasetReference, JobReference, RoutineInfo, RoutineReference, SchemaField, TableInfo, TableReference } from "../domain/google.js"
import type { JobState, JobStatus, ResultPage } from "../ports.js"
import { isRecord, text } from "./http.js"

export interface JobReferenceWire {
  readonly projectId?: string
  readonly jobId?: string
  readonly location?: string
}

export interface QueryStatisticsWire {
  readonly statementType?: string
  readonly totalBytesProcessed?: string
  readonly totalBytesProcessedAccuracy?: string
  readonly totalBytesBilled?: string
  readonly totalSlotMs?: string
  readonly cacheHit?: boolean
  readonly referencedTables?: readonly TableReference[]
  readonly referencedLogicalViews?: readonly TableReference[]
  readonly referencedRoutines?: readonly RoutineReference[]
  readonly referencedPropertyGraphs?: readonly { readonly projectId?: string; readonly datasetId?: string; readonly propertyGraphId?: string }[]
  readonly schema?: { readonly fields?: readonly SchemaField[] }
  readonly numDmlAffectedRows?: string
  readonly ddlOperationPerformed?: string
}

/** The Job resource: `configuration`, `jobReference`, `statistics` and `status`; `state` on a jobs.list item. */
export interface JobWire {
  readonly jobReference?: JobReferenceWire
  /** jobs.list answers each item's state here as well as in `status` (…/jobs/list). */
  readonly state?: string
  readonly configuration?: {
    readonly dryRun?: boolean
    readonly jobTimeoutMs?: string
    readonly labels?: Readonly<Record<string, string>>
    readonly query?: { readonly query?: string }
  }
  readonly statistics?: {
    readonly creationTime?: string
    readonly startTime?: string
    readonly endTime?: string
    readonly totalBytesProcessed?: string
    readonly totalSlotMs?: string
    readonly query?: QueryStatisticsWire
  }
  readonly status?: {
    readonly state?: string
    readonly errorResult?: unknown
    readonly errors?: readonly unknown[]
  }
}

/** `jobs.getQueryResults`' answer. */
export interface QueryResultsWire {
  readonly jobReference?: JobReferenceWire
  readonly jobComplete?: boolean
  readonly schema?: { readonly fields?: readonly SchemaField[] }
  readonly totalRows?: string
  readonly pageToken?: string
  readonly rows?: readonly unknown[]
  readonly totalBytesProcessed?: string
  readonly errors?: readonly unknown[]
  readonly cacheHit?: boolean
  readonly numDmlAffectedRows?: string
}

/** `tabledata.list`' answer: rows in `f`/`v` form, and no schema (the table's `tables.get` schema applies). */
export interface TableDataWire {
  readonly totalRows?: string
  readonly pageToken?: string
  readonly rows?: readonly unknown[]
}

/** The Table resource. */
export interface TableWire {
  readonly tableReference?: TableReference
  readonly type?: string
  readonly location?: string
  readonly numBytes?: string
  readonly numRows?: string
  readonly lastModifiedTime?: string
  readonly schema?: { readonly fields?: readonly SchemaField[] }
  readonly view?: { readonly query?: string; readonly useLegacySql?: boolean }
  readonly materializedView?: { readonly query?: string }
  readonly externalDataConfiguration?: unknown
  readonly biglakeConfiguration?: unknown
  readonly cloneDefinition?: unknown
  readonly timePartitioning?: { readonly type?: string; readonly field?: string; readonly requirePartitionFilter?: boolean }
  readonly rangePartitioning?: { readonly field?: string; readonly range?: { readonly start?: string; readonly end?: string; readonly interval?: string } }
  readonly requirePartitionFilter?: boolean
  readonly clustering?: { readonly fields?: readonly string[] }
  readonly description?: string
  readonly expirationTime?: string
}

/** The Routine resource's fields expansion reads. */
export interface RoutineWire {
  readonly routineReference?: RoutineReference
  readonly routineType?: string
  readonly language?: string
  readonly definitionBody?: string
  readonly remoteFunctionOptions?: unknown
  readonly arguments?: readonly { readonly name?: string; readonly dataType?: unknown }[]
}

/** The Job as the port reports it. `fallback` is the reference this call asked for. */
export function toJobStatus(job: JobWire, fallback: JobReference & { readonly location: string }): JobStatus {
  const ref = job.jobReference
  const reference = {
    projectId: text(ref?.projectId) ?? fallback.projectId,
    jobId: text(ref?.jobId) ?? fallback.jobId,
    location: text(ref?.location) ?? fallback.location,
  }
  const query = job.statistics?.query
  const state = jobState(job.status?.state ?? job.state)
  const error = toErrorProto(job.status?.errorResult ?? job.status?.errors?.[0])
  const sql = job.configuration?.query?.query
  return {
    ref: reference,
    state,
    ...(text(query?.statementType) !== undefined ? { statementType: text(query?.statementType)! } : {}),
    ...(bytes(query?.totalBytesProcessed ?? job.statistics?.totalBytesProcessed) !== undefined
      ? { totalBytesProcessed: bytes(query?.totalBytesProcessed ?? job.statistics?.totalBytesProcessed)! }
      : {}),
    ...(bytes(query?.totalBytesBilled) !== undefined ? { totalBytesBilled: bytes(query?.totalBytesBilled)! } : {}),
    ...(query?.cacheHit !== undefined ? { cacheHit: query.cacheHit } : {}),
    ...(bytes(query?.totalSlotMs ?? job.statistics?.totalSlotMs) !== undefined ? { totalSlotMs: bytes(query?.totalSlotMs ?? job.statistics?.totalSlotMs)! } : {}),
    ...(Array.isArray(query?.referencedTables) ? { referencedTables: query.referencedTables } : {}),
    ...(Array.isArray(query?.referencedLogicalViews) ? { referencedLogicalViews: query.referencedLogicalViews } : {}),
    ...(Array.isArray(query?.referencedRoutines) ? { referencedRoutines: query.referencedRoutines } : {}),
    ...(bytes(query?.numDmlAffectedRows) !== undefined ? { numDmlAffectedRows: bytes(query?.numDmlAffectedRows)! } : {}),
    ...(text(query?.ddlOperationPerformed) !== undefined ? { ddlOperationPerformed: text(query?.ddlOperationPerformed)! } : {}),
    ...(job.configuration?.labels !== undefined ? { labels: job.configuration.labels } : {}),
    ...(bytes(job.statistics?.creationTime) !== undefined ? { creationTime: bytes(job.statistics?.creationTime)! } : {}),
    ...(bytes(job.statistics?.endTime) !== undefined ? { endTime: bytes(job.statistics?.endTime)! } : {}),
    ...(sql !== undefined ? { sqlPreview: sql.slice(0, 200) } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

/** Google's `ErrorProto` (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#errorproto), as `JobStatus` carries it. */
export function toErrorProto(value: unknown): { readonly reason?: string; readonly location?: string; readonly message?: string } | undefined {
  if (!isRecord(value)) return undefined
  const proto = {
    ...(text(value.reason) !== undefined ? { reason: text(value.reason)! } : {}),
    ...(text(value.location) !== undefined ? { location: text(value.location)! } : {}),
    ...(text(value.message) !== undefined ? { message: text(value.message) } : {}),
  }
  return Object.keys(proto).length > 0 ? proto : undefined
}

/** A `getQueryResults` page: its rows stay in Google's `f`/`v` form for `src/process/values.ts`. */
export function toResultPage(page: QueryResultsWire): ResultPage {
  return {
    complete: page.jobComplete === true,
    ...(page.schema?.fields !== undefined ? { schema: page.schema.fields } : {}),
    rows: Array.isArray(page.rows) ? page.rows : [],
    ...(bytes(page.totalRows) !== undefined ? { totalRows: bytes(page.totalRows)! } : {}),
    ...(text(page.pageToken) !== undefined ? { pageToken: text(page.pageToken)! } : {}),
  }
}

/** A `tabledata.list` page; the table's own schema, from `tables.get`, applies to its rows. */
export function toTableDataPage(page: TableDataWire): ResultPage {
  return {
    complete: text(page.pageToken) === undefined,
    rows: Array.isArray(page.rows) ? page.rows : [],
    ...(bytes(page.totalRows) !== undefined ? { totalRows: bytes(page.totalRows)! } : {}),
    ...(text(page.pageToken) !== undefined ? { pageToken: text(page.pageToken)! } : {}),
  }
}

/** The Table resource as the guards read it. */
export function toTableInfo(table: TableWire): TableInfo {
  const ref = table.tableReference
  if (!ref || text(ref.projectId) === undefined || text(ref.datasetId) === undefined || text(ref.tableId) === undefined) {
    throw new BigQueryError("UNAVAILABLE", "Google's table answer carried no table reference")
  }
  return {
    tableReference: ref,
    ...(table.type !== undefined ? { type: table.type } : {}),
    ...(table.location !== undefined ? { location: table.location } : {}),
    ...(table.numBytes !== undefined ? { numBytes: table.numBytes } : {}),
    ...(table.numRows !== undefined ? { numRows: table.numRows } : {}),
    ...(table.lastModifiedTime !== undefined ? { lastModifiedTime: table.lastModifiedTime } : {}),
    ...(table.schema !== undefined ? { schema: table.schema } : {}),
    ...(table.view !== undefined ? { view: table.view } : {}),
    ...(table.materializedView !== undefined ? { materializedView: table.materializedView } : {}),
    ...(table.externalDataConfiguration !== undefined ? { externalDataConfiguration: table.externalDataConfiguration } : {}),
    ...(table.biglakeConfiguration !== undefined ? { biglakeConfiguration: table.biglakeConfiguration } : {}),
    ...(table.cloneDefinition !== undefined ? { cloneDefinition: table.cloneDefinition } : {}),
    ...(table.timePartitioning !== undefined ? { timePartitioning: table.timePartitioning } : {}),
    ...(table.rangePartitioning !== undefined ? { rangePartitioning: table.rangePartitioning } : {}),
    ...(table.requirePartitionFilter !== undefined ? { requirePartitionFilter: table.requirePartitionFilter } : {}),
    ...(table.clustering !== undefined ? { clustering: table.clustering } : {}),
    ...(table.description !== undefined ? { description: table.description } : {}),
    ...(table.expirationTime !== undefined ? { expirationTime: table.expirationTime } : {}),
  }
}

/** The Routine resource as expansion reads it. */
export function toRoutineInfo(routine: RoutineWire): RoutineInfo {
  const ref = routine.routineReference
  if (!ref || text(ref.projectId) === undefined || text(ref.datasetId) === undefined || text(ref.routineId) === undefined) {
    throw new BigQueryError("UNAVAILABLE", "Google's routine answer carried no routine reference")
  }
  return {
    routineReference: ref,
    ...(routine.routineType !== undefined ? { routineType: routine.routineType } : {}),
    ...(routine.language !== undefined ? { language: routine.language } : {}),
    ...(routine.definitionBody !== undefined ? { definitionBody: routine.definitionBody } : {}),
    ...(routine.remoteFunctionOptions !== undefined ? { remoteFunctionOptions: routine.remoteFunctionOptions } : {}),
    ...(routine.arguments !== undefined ? { arguments: routine.arguments } : {}),
  }
}

/** A dataset as `datasets.list` answers it. */
export function toDataset(dataset: { readonly datasetReference?: DatasetReference; readonly location?: string }): { ref: DatasetReference; location?: string } {
  const ref = dataset.datasetReference
  if (!ref || text(ref.projectId) === undefined || text(ref.datasetId) === undefined) {
    throw new BigQueryError("UNAVAILABLE", "Google's dataset answer carried no dataset reference")
  }
  return { ref, ...(dataset.location !== undefined ? { location: dataset.location } : {}) }
}

/** A `Page`'s token, when Google sent one. */
export function pageTokenOf(body: unknown): string | undefined {
  return isRecord(body) ? text(body.nextPageToken) : undefined
}

/** Every item of a list answer's named array. */
export function itemsOf(body: unknown, key: string): readonly unknown[] {
  if (!isRecord(body)) return []
  const items = body[key]
  return Array.isArray(items) ? items : []
}

/** An int64 field, as a number; undefined when absent, empty or not a number. */
export function bytes(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string" || value.trim() === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function jobState(state: string | undefined): JobState {
  return state === "RUNNING" || state === "DONE" ? state : "PENDING"
}
