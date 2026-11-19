/**
 * The ports: every boundary between the plugin's decisions and the outside world, as interfaces. Each package builds
 * against these, and `test/fake/ports.ts` has a fake for each, so the packages build in parallel (docs/ownership.md).
 *
 * - `BigQueryPort` (package B builds it over `fetch`): BigQuery's REST calls. Dry runs and runs go through jobs.insert
 *   with a client-chosen job id; jobs.query only for the bind-time estimate of a saved query.
 * - `AuthPort` (package A): an access token for an account, and its level, which is `write` only when both checks of
 *   design §3.1 pass (`decideLevel` in src/domain/levels.ts).
 * - `LedgerPort` (package C): the spend ledger, counted from what Google actually billed.
 * - `PlanStorePort` (Day 0, src/domain/plans.ts): single-use plans.
 * - `Clock`: time and ids, so tests are deterministic.
 *
 * Every call takes the call's `signal`; a stopped call aborts its request.
 */
import type {
  Accuracy,
  DatasetReference,
  DryRunStatistics,
  GoogleErrorProto,
  JobReference,
  QueryParameter,
  RoutineInfo,
  RoutineReference,
  SchemaField,
  TableInfo,
  TableReference,
} from "./domain/google.js"
import type { LevelDecision, Mode } from "./domain/levels.js"
import type { PlanStorePort } from "./domain/plans.js"

export type { PlanStorePort } from "./domain/plans.js"

// ── BigQuery ─────────────────────────────────────────────────────────────

/** One query job, as jobs.insert's `configuration.query` carries it. Never a destination, a session or a connection. */
export interface QueryJobRequest {
  readonly account: string
  /** The project the job runs in and bills to. */
  readonly project: string
  readonly sql: string
  readonly params?: readonly QueryParameter[]
  readonly defaultDataset?: DatasetReference
  readonly location?: string
  readonly useQueryCache?: boolean
}

export interface DryRunAnswer {
  /** The location BigQuery chose; the run is pinned to it. */
  readonly location: string
  /** `statistics.query`, or undefined when BigQuery returned none (`DRY_RUN_INCOMPLETE`). */
  readonly statistics?: DryRunStatistics
}

/** A run: a dry-run-checked statement with its client job id, cap, labels and time limit. */
export interface RunRequest extends QueryJobRequest {
  /** `oc_<uuid>`: a transport retry reuses it; a 409 `duplicate` joins the existing job. */
  readonly jobId: string
  readonly location: string
  readonly maximumBytesBilled: number
  readonly jobTimeoutMs: number
  readonly labels: Readonly<Record<string, string>>
}

export type JobState = "PENDING" | "RUNNING" | "DONE"

export interface JobStatus {
  readonly ref: JobReference & { readonly location: string }
  readonly state: JobState
  readonly statementType?: string
  readonly totalBytesProcessed?: number
  readonly totalBytesBilled?: number
  readonly cacheHit?: boolean
  readonly totalSlotMs?: number
  readonly referencedTables?: readonly TableReference[]
  readonly referencedLogicalViews?: readonly TableReference[]
  readonly referencedRoutines?: readonly RoutineReference[]
  readonly numDmlAffectedRows?: number
  readonly ddlOperationPerformed?: string
  readonly labels?: Readonly<Record<string, string>>
  readonly creationTime?: number
  readonly endTime?: number
  /** The first 200 characters of the job's SQL, for listings. Untrusted. */
  readonly sqlPreview?: string
  readonly error?: GoogleErrorProto
}

/** One page of a finished query's results, in Google's row form (`f`/`v`); the runtime converts the values. */
export interface ResultPage {
  readonly complete: boolean
  readonly schema?: readonly SchemaField[]
  readonly rows: readonly unknown[]
  readonly totalRows?: number
  /** The token for the next page; absent on the last. Google's getQueryResults (and tabledata.list) `pageToken`. */
  readonly pageToken?: string
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextPageToken?: string
  /** jobs.list's `unreachable[]`: locations Google skipped, so the page is not complete for them. */
  readonly unreachable?: readonly string[]
  /** jobs.list: the answer's HTTP `Date`, Google's clock when it answered, in ms (to the second). */
  readonly serverTime?: number
}

export interface ListInput {
  readonly account: string
  readonly pageToken?: string
  readonly maxResults?: number
}

export interface BigQueryPort {
  /** jobs.insert with `dryRun: true`: free; the statistics the guards need. */
  dryRun(request: QueryJobRequest, signal: AbortSignal): Promise<DryRunAnswer>
  /** jobs.query with `dryRun: true`: the bind-time estimate of a saved query only. Names no tables and no accuracy. */
  estimate(request: QueryJobRequest, signal: AbortSignal): Promise<{ readonly statementType?: string; readonly totalBytesProcessed?: number }>
  /** jobs.insert with the client job id; a 409 `duplicate` joins the existing job with jobs.get. */
  run(request: RunRequest, signal: AbortSignal): Promise<JobStatus>
  /** jobs.getQueryResults: long-polls up to `timeoutMs`, at most `maxResults` rows. */
  results(account: string, ref: JobReference, page: { readonly timeoutMs: number; readonly maxResults: number; readonly pageToken?: string }, signal: AbortSignal): Promise<ResultPage>
  getJob(account: string, ref: JobReference, signal: AbortSignal): Promise<JobStatus>
  listJobs(input: ListInput & { readonly project: string; readonly stateFilter?: "done" | "pending" | "running"; readonly minCreationTime?: number; readonly maxCreationTime?: number }, signal: AbortSignal): Promise<Page<JobStatus>>
  /** jobs.cancel: only a job this account started. */
  cancel(account: string, ref: JobReference, signal: AbortSignal): Promise<JobStatus>
  listProjects(input: ListInput, signal: AbortSignal): Promise<Page<{ readonly projectId: string; readonly friendlyName?: string }>>
  listDatasets(input: ListInput & { readonly project: string }, signal: AbortSignal): Promise<Page<{ readonly ref: DatasetReference; readonly location?: string }>>
  listTables(input: ListInput & { readonly dataset: DatasetReference }, signal: AbortSignal): Promise<Page<TableInfo>>
  getTable(account: string, ref: TableReference, signal: AbortSignal): Promise<TableInfo>
  /** tabledata.list: `selectedFields` always names the fields to read; tagged fields are left out by the caller. */
  listTableData(account: string, ref: TableReference, page: { readonly maxResults: number; readonly selectedFields: readonly string[]; readonly pageToken?: string }, signal: AbortSignal): Promise<ResultPage>
  listRoutines(input: ListInput & { readonly dataset: DatasetReference }, signal: AbortSignal): Promise<Page<RoutineInfo>>
  getRoutine(account: string, ref: RoutineReference, signal: AbortSignal): Promise<RoutineInfo>
  /** rowAccessPolicies.list: definitive when it answers; a 403 for a Data Viewer. */
  listRowAccessPolicies(account: string, ref: TableReference, signal: AbortSignal): Promise<Page<{ readonly policyId: string }>>
  /** tables.testIamPermissions: which of `permissions` the caller holds on the table. */
  testTablePermissions(account: string, ref: TableReference, permissions: readonly string[], signal: AbortSignal): Promise<readonly string[]>
}

// ── Auth ─────────────────────────────────────────────────────────────────

export interface AccessToken {
  /** The bearer token. Never logged, never in a result. */
  readonly token: string
  readonly expiresAt: number
  /**
   * The scope list of Google's answer to the refresh that minted this token; empty when unknown (a `token` account has
   * no refresh): callers must not read empty as a missing scope.
   */
  readonly scopes: readonly string[]
}

export interface Identity {
  /** The signed-in address, or the service account's. */
  readonly email?: string
  /** False for a `token` account whose identity Google does not report. */
  readonly verified: boolean
}

export interface AuthPort {
  /** An access token for the account, from memory or a fresh refresh. Throws `AUTH_REQUIRED` and kin. */
  token(account: string, signal: AbortSignal): Promise<AccessToken>
  /**
   * The account's level. Refreshes first when no refresh has answered in this process, and decides with `decideLevel`
   * from that answer's scopes: `write` only on both checks of design §3.1.
   */
  level(account: string, signal: AbortSignal): Promise<LevelDecision>
  identity(account: string, signal: AbortSignal): Promise<Identity>
  /** The stored sign-in's device binding; undefined for a headless account or no sign-in; never a Google call. */
  binding(account: string, signal: AbortSignal): Promise<"bound" | "unbound" | undefined>
  /** The configured accounts and their modes. */
  accounts(): readonly { readonly alias: string; readonly mode: Mode }[]
}

// ── Spend ────────────────────────────────────────────────────────────────

/** One finished job's bill, from its actual `totalBytesBilled`. */
export interface SpendEntry {
  /** ISO time the job finished. */
  readonly at: string
  readonly account: string
  readonly project: string
  readonly location: string
  readonly jobId: string
  readonly bytesBilled: number
  /** The tool or source that ran it: `bigquery_query`, `saved_read` and so on. */
  readonly via: string
  /** A hash of the session id, never the id itself. */
  readonly session: string
}

export interface LedgerPort {
  /** Appends one entry, atomically, under a cross-process lock. */
  record(entry: SpendEntry): Promise<void>
  /** Bytes billed since `since` (ms), for one account, optionally one session hash. */
  spent(query: { readonly account: string; readonly since: number; readonly session?: string }): Promise<number>
}

// ── Time and ids ─────────────────────────────────────────────────────────

export interface Clock {
  now(): number
  /** A random UUID; job ids are `oc_<uuid>`. */
  uuid(): string
}

/** Everything a tool handler gets besides its input and call. */
export interface Ports {
  readonly bigquery: BigQueryPort
  readonly auth: AuthPort
  readonly ledger: LedgerPort
  readonly plans: PlanStorePort
  readonly clock: Clock
  /**
   * False when this install is not a tagged release: a tool that would call Google refuses before its handler.
   * Absent on a test's own ports, so those tests keep using the handlers. Production sets it from `isTaggedRelease`.
   */
  readonly released?: boolean
}

/** The dry run's numbers as the guards read them. */
export interface Estimate {
  readonly bytes: number
  readonly accuracy?: Accuracy
}
