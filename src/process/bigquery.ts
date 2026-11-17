/**
 * The BigQuery port over `fetch` (design §5.1 step 9, §8). Every call is one REST method under
 * https://bigquery.googleapis.com/bigquery/v2, with the reference shapes in `src/process/wire.ts`:
 *
 * - dry runs and runs are `jobs.insert` with a client-chosen job id (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert);
 *   `jobs.query` is used only for a saved query's bind-time estimate (…/jobs/query);
 * - a duplicate job id is a 409 with reason `duplicate` (https://cloud.google.com/bigquery/docs/error-messages), and
 *   is joined with `jobs.get` (…/jobs/get) so a transport retry never runs a query twice;
 * - results are `jobs.getQueryResults` (…/jobs/getQueryResults);
 * - a stop aborts the request and cancels the job this call started, with `jobs.cancel` (…/jobs/cancel);
 * - the reads the guards and listings need are `jobs.get`/`jobs.list`, `projects.list`, `datasets.list`,
 *   `tables.list`/`tables.get`, `tabledata.list`, `routines.list`/`routines.get`, `rowAccessPolicies.list` and
 *   `tables.testIamPermissions`.
 *
 * What the port will not do, whatever the caller asks: send a destination table, a write disposition, a session or a
 * connection property. The request body is built from the fields of `QueryJobRequest` alone, so the read path cannot
 * become anything else by passing an object with extra keys.
 *
 * Google's own failure is reported as the plugin's code for it (`JOB_FAILED`, `BYTES_BILLED_LIMIT`, `JOB_TIMEOUT`,
 * `NOT_FOUND`, `PERMISSION_DENIED`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `UNAVAILABLE`), with Google's words only in
 * `googleError`. The read path turns `JOB_FAILED` with reason `invalidQuery` into `SQL_INVALID` (package C), because
 * only it has the SQL's position to show.
 */
import { BigQueryError } from "../domain/errors.js"
import type { Accuracy, DatasetReference, JobReference, QueryParameter, RoutineInfo, RoutineReference, TableInfo, TableReference } from "../domain/google.js"
import { ident } from "../domain/identifiers.js"
import type { Options } from "../options.js"
import type { AuthPort, BigQueryPort, DryRunAnswer, JobStatus, ListInput, Page, QueryJobRequest, ResultPage, RunRequest } from "../ports.js"
import { cancelled, createHttp, jobFailure, type Http } from "./http.js"
import {
  itemsOf,
  pageTokenOf,
  toDataset,
  toJobStatus,
  toResultPage,
  toRoutineInfo,
  toTableDataPage,
  toTableInfo,
  type JobWire,
  type QueryResultsWire,
  type RoutineWire,
  type TableWire,
} from "./wire.js"

export interface BigQueryDeps {
  readonly options: Options
  readonly auth: AuthPort
  readonly fetch: typeof globalThis.fetch
  /** Tests shrink the retry delays; production uses design §8's backoff. */
  readonly retry?: { readonly tries?: number; readonly baseDelayMs?: number; readonly maxDelayMs?: number; readonly jitter?: boolean }
  readonly maxInFlight?: number
}

/** A run's id: `oc_<uuid>`, ours, so a retry and a duplicate join name the same job (design §5.1 step 9). */
const RUN_ID = /^oc_[A-Za-z0-9_-]{1,1019}$/

/**
 * The transport takes no plugin option: the byte cap, the time limit and the labels arrive with each run, and job
 * concurrency (`maxConcurrentJobs`, design §6.2) is the read path's guard, because only it knows when a job's results
 * are done. `options` stays in the deps so `src/wiring.ts` keeps one shape for every port.
 */
export function createBigQueryPort(deps: BigQueryDeps): BigQueryPort {
  const http = createHttp({ auth: deps.auth, fetch: deps.fetch, retry: deps.retry, maxInFlight: deps.maxInFlight })
  return new BigQueryRuntime(http)
}

/** Jobs this process started, so a stop cancels only its own call's job (design §8). */
const REMEMBERED = 256

class BigQueryRuntime implements BigQueryPort {
  private readonly http: Http
  private readonly started = new Map<string, { readonly account: string; readonly ref: JobReference }>()

  constructor(http: Http) {
    this.http = http
  }

  async dryRun(request: QueryJobRequest, signal: AbortSignal): Promise<DryRunAnswer> {
    const job = await this.http.request<JobWire>({
      account: request.account,
      method: "POST",
      path: this.jobsPath(request.project),
      body: {
        jobReference: { projectId: request.project, ...(request.location !== undefined ? { location: request.location } : {}) },
        configuration: { query: queryConfiguration(request), dryRun: true },
      },
      task: `the dry run in ${ident(request.project)}`,
      signal,
      idempotent: true,
    })
    // TODO(L8): a dry-run answer is expected to name the location it chose, in jobReference.location. When it does not,
    // the run is sent without one and Google routes it by its datasets; live check L8 says whether that happens.
    const location = job.jobReference?.location ?? request.location ?? ""
    const statistics = job.statistics?.query
    return { location, ...(statistics !== undefined ? { statistics: dryRunStatistics(statistics) } : {}) }
  }

  async estimate(request: QueryJobRequest, signal: AbortSignal): Promise<{ readonly statementType?: string; readonly totalBytesProcessed?: number }> {
    const body = await this.http.request<{ readonly statementType?: string; readonly totalBytesProcessed?: string }>({
      account: request.account,
      method: "POST",
      path: `/projects/${this.http.segment(request.project)}/queries`,
      body: {
        ...queryConfiguration(request),
        dryRun: true,
        maxResults: 0,
        ...(request.location !== undefined ? { location: request.location } : {}),
      },
      task: `the estimate in ${ident(request.project)}`,
      signal,
      idempotent: true,
    })
    const total = Number(body.totalBytesProcessed)
    return {
      ...(body.statementType !== undefined ? { statementType: body.statementType } : {}),
      ...(body.totalBytesProcessed !== undefined && Number.isFinite(total) ? { totalBytesProcessed: total } : {}),
    }
  }

  async run(request: RunRequest, signal: AbortSignal): Promise<JobStatus> {
    if (!RUN_ID.test(request.jobId)) {
      throw new BigQueryError("INPUT_INVALID", "A run needs a client job id of the form oc_<uuid>", "This is a plugin bug: report it with the call that made it.")
    }
    if (!Number.isSafeInteger(request.maximumBytesBilled) || request.maximumBytesBilled <= 0) {
      throw new BigQueryError("INPUT_INVALID", "A run needs a positive byte cap", "This is a plugin bug: report it with the call that made it.")
    }
    if (!Number.isSafeInteger(request.jobTimeoutMs) || request.jobTimeoutMs <= 0) {
      throw new BigQueryError("INPUT_INVALID", "A run needs a positive job time limit", "This is a plugin bug: report it with the call that made it.")
    }
    // A signal already stopped sends nothing, so there is no job to cancel either.
    if (signal.aborted) throw cancelled()
    const ref: JobReference = {
      projectId: request.project,
      jobId: request.jobId,
      ...(request.location !== "" ? { location: request.location } : {}),
    }
    this.remember(request.account, ref)
    let job: JobWire
    try {
      job = await this.http.request<JobWire>({
        account: request.account,
        method: "POST",
        path: this.jobsPath(request.project),
        body: {
          jobReference: ref,
          configuration: {
            query: { ...queryConfiguration(request), maximumBytesBilled: String(request.maximumBytesBilled) },
            dryRun: false,
            jobTimeoutMs: String(request.jobTimeoutMs),
            labels: cleanLabels(request.labels),
          },
        },
        task: `the query job ${ident(request.jobId)}`,
        signal,
        // A run carries its own job id: a transport retry names the same job, and a 409 joins it (design §5.1 step 9).
        idempotent: true,
      })
    } catch (error) {
      if (error instanceof BigQueryError && error.extras.googleError?.reason === "duplicate") {
        // Google already has this job: the first attempt of this same call reached it. Join it; never run it twice.
        const joined = await this.getJob(request.account, ref, signal)
        if (joined.state === "DONE" && joined.error !== undefined) throw jobFailure(joined.error, ident(request.jobId))
        return joined
      }
      await this.stopped(request.account, ref, signal, error)
      this.forget(request.account, ref)
      throw error
    }
    const status = toJobStatus(job, { projectId: request.project, jobId: request.jobId, location: request.location })
    if (status.state === "DONE" && status.error !== undefined) throw jobFailure(status.error, ident(request.jobId))
    return status
  }

  async results(
    account: string,
    ref: JobReference,
    page: { readonly timeoutMs: number; readonly maxResults: number; readonly pageToken?: string },
    signal: AbortSignal,
  ): Promise<ResultPage> {
    try {
      const answer = await this.http.request<QueryResultsWire>({
        account,
        method: "GET",
        path: this.queryResultsPath(ref),
        query: {
          timeoutMs: page.timeoutMs,
          maxResults: Math.max(1, page.maxResults),
          ...(page.pageToken !== undefined ? { pageToken: page.pageToken } : {}),
          ...(ref.location !== undefined ? { location: ref.location } : {}),
        },
        task: `the results of ${ident(ref.jobId)}`,
        signal,
        idempotent: true,
      })
      if (answer.jobComplete === true && Array.isArray(answer.errors) && answer.errors.length > 0) throw jobFailure(answer.errors[0], ident(ref.jobId))
      return toResultPage(answer)
    } catch (error) {
      await this.stopped(account, ref, signal, error)
      throw error
    }
  }

  async getJob(account: string, ref: JobReference, signal: AbortSignal): Promise<JobStatus> {
    const job = await this.http.request<JobWire>({
      account,
      method: "GET",
      path: this.jobsPath(ref.projectId, ref.jobId),
      query: ref.location !== undefined ? { location: ref.location } : undefined,
      task: `the job ${ident(ref.jobId)}`,
      signal,
      idempotent: true,
    })
    return toJobStatus(job, { projectId: ref.projectId, jobId: ref.jobId, location: ref.location ?? "" })
  }

  async listJobs(
    input: ListInput & { readonly project: string; readonly stateFilter?: "done" | "pending" | "running"; readonly minCreationTime?: number; readonly maxCreationTime?: number },
    signal: AbortSignal,
  ): Promise<Page<JobStatus>> {
    const body = await this.http.request<unknown>({
      account: input.account,
      method: "GET",
      path: this.jobsPath(input.project),
      query: {
        allUsers: "false",
        projection: "full",
        ...(input.stateFilter !== undefined ? { stateFilter: input.stateFilter } : {}),
        ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
        ...(input.minCreationTime !== undefined ? { minCreationTime: input.minCreationTime } : {}),
        ...(input.maxCreationTime !== undefined ? { maxCreationTime: input.maxCreationTime } : {}),
      },
      task: `the jobs of ${ident(input.project)}`,
      signal,
      idempotent: true,
    })
    return {
      items: itemsOf(body, "jobs").flatMap((item) => {
        const job = item as JobWire
        const jobId = job.jobReference?.jobId
        return typeof jobId === "string" ? [toJobStatus(job, { projectId: input.project, jobId, location: "" })] : []
      }),
      ...(pageTokenOf(body) !== undefined ? { nextPageToken: pageTokenOf(body)! } : {}),
    }
  }

  async cancel(account: string, ref: JobReference, signal: AbortSignal): Promise<JobStatus> {
    const job = await this.http.request<JobWire>({
      account,
      method: "POST",
      path: `${this.jobsPath(ref.projectId, ref.jobId)}/cancel`,
      query: ref.location !== undefined ? { location: ref.location } : undefined,
      body: {},
      task: `the job ${ident(ref.jobId)}`,
      signal,
      idempotent: true,
    })
    this.forget(account, ref)
    return toJobStatus(job, { projectId: ref.projectId, jobId: ref.jobId, location: ref.location ?? "" })
  }

  async listProjects(input: ListInput, signal: AbortSignal): Promise<Page<{ readonly projectId: string; readonly friendlyName?: string }>> {
    const body = await this.http.request<unknown>({
      account: input.account,
      method: "GET",
      path: "/projects",
      query: { ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}), ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}) },
      task: "your projects",
      signal,
      idempotent: true,
    })
    return {
      items: itemsOf(body, "projects").flatMap((item) => {
        const project = item as { readonly projectReference?: { readonly projectId?: string }; readonly friendlyName?: string }
        const projectId = project.projectReference?.projectId
        return projectId === undefined ? [] : [{ projectId, ...(project.friendlyName !== undefined ? { friendlyName: project.friendlyName } : {}) }]
      }),
      ...page(body),
    }
  }

  async listDatasets(input: ListInput & { readonly project: string }, signal: AbortSignal): Promise<Page<{ readonly ref: DatasetReference; readonly location?: string }>> {
    const body = await this.http.request<unknown>({
      account: input.account,
      method: "GET",
      path: `/projects/${this.http.segment(input.project)}/datasets`,
      query: { ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}), ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}) },
      task: `the datasets of ${ident(input.project)}`,
      signal,
      idempotent: true,
    })
    return {
      items: itemsOf(body, "datasets").map((item) => toDataset(item as { datasetReference?: DatasetReference; location?: string })),
      ...page(body),
    }
  }

  async listTables(input: ListInput & { readonly dataset: DatasetReference }, signal: AbortSignal): Promise<Page<TableInfo>> {
    const body = await this.http.request<unknown>({
      account: input.account,
      method: "GET",
      path: this.tablesPath(input.dataset),
      query: { ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}), ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}) },
      task: `the tables of ${ident(input.dataset.projectId)}.${ident(input.dataset.datasetId)}`,
      signal,
      idempotent: true,
    })
    return { items: itemsOf(body, "tables").map((item) => toTableInfo(item as TableWire)), ...page(body) }
  }

  async getTable(account: string, ref: TableReference, signal: AbortSignal): Promise<TableInfo> {
    const table = await this.http.request<TableWire>({
      account,
      method: "GET",
      path: this.tablePath(ref),
      task: `the table ${ident(ref.projectId)}.${ident(ref.datasetId)}.${ident(ref.tableId)}`,
      signal,
      idempotent: true,
    })
    return toTableInfo(table)
  }

  async listTableData(
    account: string,
    ref: TableReference,
    page: { readonly maxResults: number; readonly selectedFields: readonly string[]; readonly pageToken?: string },
    signal: AbortSignal,
  ): Promise<ResultPage> {
    const body = await this.http.request<unknown>({
      account,
      method: "GET",
      path: `${this.tablePath(ref)}/data`,
      query: {
        maxResults: page.maxResults,
        ...(page.selectedFields.length > 0 ? { selectedFields: page.selectedFields.join(",") } : {}),
        ...(page.pageToken !== undefined ? { pageToken: page.pageToken } : {}),
      },
      task: `the rows of ${ident(ref.projectId)}.${ident(ref.datasetId)}.${ident(ref.tableId)}`,
      signal,
      idempotent: true,
    })
    return toTableDataPage(body as { totalRows?: string; pageToken?: string; rows?: readonly unknown[] })
  }

  async listRoutines(input: ListInput & { readonly dataset: DatasetReference }, signal: AbortSignal): Promise<Page<RoutineInfo>> {
    const body = await this.http.request<unknown>({
      account: input.account,
      method: "GET",
      path: `${this.datasetPath(input.dataset)}/routines`,
      query: { ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}), ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}) },
      task: `the routines of ${ident(input.dataset.projectId)}.${ident(input.dataset.datasetId)}`,
      signal,
      idempotent: true,
    })
    return { items: itemsOf(body, "routines").map((item) => toRoutineInfo(item as RoutineWire)), ...page(body) }
  }

  async getRoutine(account: string, ref: RoutineReference, signal: AbortSignal): Promise<RoutineInfo> {
    const routine = await this.http.request<RoutineWire>({
      account,
      method: "GET",
      path: `${this.datasetPath(ref)}/routines/${this.http.segment(ref.routineId)}`,
      task: `the routine ${ident(ref.projectId)}.${ident(ref.datasetId)}.${ident(ref.routineId)}`,
      signal,
      idempotent: true,
    })
    return toRoutineInfo(routine)
  }

  async listRowAccessPolicies(account: string, ref: TableReference, signal: AbortSignal): Promise<Page<{ readonly policyId: string }>> {
    const body = await this.http.request<unknown>({
      account,
      method: "GET",
      path: `${this.tablePath(ref)}/rowAccessPolicies`,
      task: `the row access policies of ${ident(ref.projectId)}.${ident(ref.datasetId)}.${ident(ref.tableId)}`,
      signal,
      idempotent: true,
    })
    return {
      items: itemsOf(body, "rowAccessPolicies").flatMap((item) => {
        const policyId = (item as { readonly policyId?: unknown }).policyId
        return typeof policyId === "string" ? [{ policyId }] : []
      }),
      ...page(body),
    }
  }

  async testTablePermissions(account: string, ref: TableReference, permissions: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
    const body = await this.http.request<unknown>({
      account,
      method: "POST",
      path: `${this.tablePath(ref)}/testIamPermissions`,
      body: { permissions },
      task: `the permissions on ${ident(ref.projectId)}.${ident(ref.datasetId)}.${ident(ref.tableId)}`,
      signal,
      idempotent: true,
    })
    return itemsOf(body, "permissions").filter((item): item is string => typeof item === "string")
  }

  // ── Paths ──────────────────────────────────────────────────────────────

  private jobsPath(project: string, jobId?: string): string {
    const base = `/projects/${this.http.segment(project)}/jobs`
    return jobId === undefined ? base : `${base}/${this.http.segment(jobId)}`
  }

  private queryResultsPath(ref: JobReference): string {
    return `/projects/${this.http.segment(ref.projectId)}/queries/${this.http.segment(ref.jobId)}`
  }

  private datasetPath(dataset: DatasetReference): string {
    return `/projects/${this.http.segment(dataset.projectId)}/datasets/${this.http.segment(dataset.datasetId)}`
  }

  private tablesPath(dataset: DatasetReference): string {
    return `${this.datasetPath(dataset)}/tables`
  }

  private tablePath(ref: TableReference): string {
    return `${this.tablesPath(ref)}/${this.http.segment(ref.tableId)}`
  }

  // ── Stop ───────────────────────────────────────────────────────────────

  /**
   * A stop cancels the job this call started (design §8). Google's cancel is a separate request, so it cannot carry the
   * stopped call's signal: it gets its own short one, and its own failure never replaces the `CANCELLED` answer.
   */
  private async stopped(account: string, ref: JobReference, signal: AbortSignal, error: unknown): Promise<void> {
    if (!signal.aborted || !(error instanceof BigQueryError) || error.code !== "CANCELLED") return
    if (!this.started.has(this.key(account, ref))) return
    try {
      await this.cancel(account, ref, AbortSignal.timeout(10_000))
    } catch {
      // The answer is the stop, not the cancel's failure: what it billed is unknown either way.
    }
  }

  private remember(account: string, ref: JobReference): void {
    const key = this.key(account, ref)
    this.started.delete(key)
    this.started.set(key, { account, ref })
    while (this.started.size > REMEMBERED) this.started.delete(this.started.keys().next().value!)
  }

  private forget(account: string, ref: JobReference): void {
    this.started.delete(this.key(account, ref))
  }

  private key(account: string, ref: JobReference): string {
    return `${account}\u0000${ref.projectId}\u0000${ref.jobId}`
  }
}

/**
 * `configuration.query` for a dry run or a run, from the port's fields alone. `jobs.query`'s estimate adds its own
 * `dryRun`, `maxResults` and `location` outside this object. Byte-identical for both, so what was estimated is what
 * runs (design §14.1).
 */
function queryConfiguration(request: QueryJobRequest): Record<string, unknown> {
  const parameters = request.params ?? []
  return {
    query: request.sql,
    useLegacySql: false,
    ...(parameters.length > 0 ? { queryParameters: parameters, parameterMode: parameterMode(parameters) } : {}),
    ...(request.defaultDataset !== undefined ? { defaultDataset: request.defaultDataset } : {}),
    ...(request.useQueryCache !== undefined ? { useQueryCache: request.useQueryCache } : {}),
  }
}

/** `NAMED` when the parameters carry names, `POSITIONAL` otherwise; the contract's params come from one or the other. */
function parameterMode(parameters: readonly QueryParameter[]): "NAMED" | "POSITIONAL" {
  return parameters.some((parameter) => parameter.name !== undefined) ? "NAMED" : "POSITIONAL"
}

/** The dry run's `statistics.query`, field by field, so nothing else from Google's answer reaches the guards. */
function dryRunStatistics(statistics: {
  readonly statementType?: string
  readonly totalBytesProcessed?: string
  readonly totalBytesProcessedAccuracy?: string
  readonly referencedTables?: readonly TableReference[]
  readonly referencedLogicalViews?: readonly TableReference[]
  readonly referencedRoutines?: readonly RoutineReference[]
  readonly referencedPropertyGraphs?: readonly { readonly projectId?: string; readonly datasetId?: string; readonly propertyGraphId?: string }[]
  readonly schema?: { readonly fields?: readonly unknown[] }
}): NonNullable<DryRunAnswer["statistics"]> {
  return {
    ...(statistics.statementType !== undefined ? { statementType: statistics.statementType } : {}),
    ...(statistics.totalBytesProcessed !== undefined ? { totalBytesProcessed: statistics.totalBytesProcessed } : {}),
    ...(accuracy(statistics.totalBytesProcessedAccuracy) !== undefined ? { totalBytesProcessedAccuracy: accuracy(statistics.totalBytesProcessedAccuracy)! } : {}),
    ...(Array.isArray(statistics.referencedTables) ? { referencedTables: statistics.referencedTables } : {}),
    ...(Array.isArray(statistics.referencedLogicalViews) ? { referencedLogicalViews: statistics.referencedLogicalViews } : {}),
    ...(Array.isArray(statistics.referencedRoutines) ? { referencedRoutines: statistics.referencedRoutines } : {}),
    ...(Array.isArray(statistics.referencedPropertyGraphs)
      ? {
          referencedPropertyGraphs: statistics.referencedPropertyGraphs.flatMap((graph) =>
            graph.projectId !== undefined && graph.datasetId !== undefined && graph.propertyGraphId !== undefined
              ? [{ projectId: graph.projectId, datasetId: graph.datasetId, propertyGraphId: graph.propertyGraphId }]
              : [],
          ),
        }
      : {}),
    ...(statistics.schema !== undefined ? { schema: statistics.schema as NonNullable<DryRunAnswer["statistics"]>["schema"] } : {}),
  }
}

function accuracy(value: string | undefined): Accuracy | undefined {
  return value === "PRECISE" || value === "UPPER_BOUND" || value === "LOWER_BOUND" || value === "UNKNOWN" ? value : undefined
}

/** A list answer's page token, when Google sent one. */
function page(body: unknown): { readonly nextPageToken?: string } {
  const token = pageTokenOf(body)
  return token === undefined ? {} : { nextPageToken: token }
}

/**
 * Google's label rules (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobconfiguration): lowercase
 * letters, digits, underscores and dashes, at most 63 characters, a key starting with a letter. Ours are already
 * `oc_plugin`, `oc_tool` and `oc_session`, so this only keeps a longer tool name or session hash from failing a
 * billable job.
 */
export function cleanLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) {
    const name = key
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 63)
    if (!/^[a-z]/.test(name)) continue
    clean[name] = value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63)
  }
  return clean
}
