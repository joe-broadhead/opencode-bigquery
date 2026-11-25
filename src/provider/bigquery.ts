/**
 * The BigQuery port over `fetch` (design §5.1 step 9, §8). Every call is one REST method under
 * https://bigquery.googleapis.com/bigquery/v2, with the reference shapes in `src/process/wire.ts`:
 *
 * - dry runs and runs are `jobs.insert` with a client-chosen job id (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert);
 *   `jobs.query` is used only for a saved query's bind-time estimate (…/jobs/query);
 * - a duplicate job id is a 409 with reason `duplicate` (https://cloud.google.com/bigquery/docs/error-messages), and
 *   is joined with `jobs.get` (…/jobs/get) so a transport retry never runs a query twice;
 * - results are `jobs.getQueryResults` (…/jobs/getQueryResults), asked for exact microsecond timestamps;
 * - a stop aborts the request and cancels the job this call started, with `jobs.cancel` (…/jobs/cancel), which answers
 *   `{ kind, job }`;
 * - the reads the guards and listings need are `jobs.get`/`jobs.list`, `projects.list`, `datasets.list`,
 *   `tables.list`/`tables.get`, `tabledata.list`, `routines.list`/`routines.get`, `rowAccessPolicies.list` and
 *   `tables.testIamPermissions`.
 *
 * What the port will not do, whatever the caller asks: send a destination table, a write disposition, a session or a
 * connection property. The request body is built from the fields of `QueryJobRequest` alone, so the read path cannot
 * become anything else by passing an object with extra keys.
 *
 * A job Google accepted and then failed is a **result**, not a transport failure: `run` and `getJob` answer its DONE
 * `JobStatus`, with `error` (`status.errorResult`) and `totalBytesBilled`, so the read path can name the code and the
 * ledger can count what it cost. Only an HTTP failure is thrown, and its code comes from Google's reason first
 * (`bytesBilledLimitExceeded`, `timeout`, `rateLimitExceeded`, …), then from the status.
 */
import { BigQueryError } from "../domain/errors.js"
import type { Accuracy, DatasetReference, JobReference, QueryParameter, RoutineInfo, RoutineReference, TableInfo, TableReference } from "../domain/google.js"
import { ident } from "../domain/identifiers.js"
import type { Options } from "../options.js"
import type { AuthPort, BigQueryPort, DryRunAnswer, JobStatus, ListInput, Page, QueryJobRequest, ResultPage, RunRequest } from "../ports.js"
import { cancelled, createHttp, delay, type Http, isRecord, jobFailure, text } from "./http.js"
import {
  itemsOf,
  type JobWire,
  pageTokenOf,
  type QueryResultsWire,
  type RoutineWire,
  type TableWire,
  toDataset,
  toJobStatus,
  toResultPage,
  toRoutineInfo,
  toTableDataPage,
  toTableInfo,
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

/** Exact TIMESTAMPs: microseconds since the epoch as an int64, not a double (design §7; DataFormatOptions). */
const EXACT_TIMESTAMPS = { "formatOptions.useInt64Timestamp": "true" } as const

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

/** Pages the policy list reads on its own while its pages are empty: an empty page with a token is not "no policy". */
const POLICY_PAGES = 10

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
        jobReference: { projectId: request.project, ...(request.location !== undefined && request.location !== "" ? { location: request.location } : {}) },
        configuration: { query: queryConfiguration(request), dryRun: true },
      },
      task: `the dry run in ${ident(request.project)}`,
      signal,
      idempotent: true,
    })
    // A dry-run answer is expected to name the location it chose, in jobReference.location. When it does not, the run is
    // sent without one and Google infers it from the datasets; that is safe only in a single-region US or EU location
    // until a live check confirms real dry-run answers carry it (docs/architecture.md's known limits).
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
        ...locationOf(request.location),
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
        const joined = await this.joined(request.account, ref, signal)
        this.remember(request.account, joined.ref)
        return joined
      }
      await this.stopped(request.account, ref, signal, error)
      this.forget(request.account, ref)
      throw error
    }
    const status = toJobStatus(job, { ...ref, location: ref.location ?? "" })
    // The answer names the location Google actually used; Stop and every later call need that one, not the request's.
    this.remember(request.account, status.ref)
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
          ...locationOf(ref.location),
          ...EXACT_TIMESTAMPS,
        },
        task: `the results of ${ident(ref.jobId)}`,
        signal,
        idempotent: true,
        deadlineMs: Math.min(page.timeoutMs + 60_000, 600_000),
      })
      // getQueryResults' `errors[]` are "the first errors or warnings … do not necessarily mean the job … was
      // unsuccessful" (…/jobs/getQueryResults): only a complete page with no schema and no rows is a failure there.
      const failed = answer.jobComplete === true && Array.isArray(answer.errors) && answer.errors.length > 0
      const hasResult = answer.schema?.fields !== undefined || (Array.isArray(answer.rows) && answer.rows.length > 0)
      if (failed && !hasResult) throw jobFailure(answer.errors![0], ident(ref.jobId))
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
      query: locationOf(ref.location),
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
    // A full-projection page carries each job's SQL; 100 keeps one page well under the 10 MiB an answer may be (L-9).
    const maxResults = input.maxResults ?? 100
    let serverTime: number | undefined
    const body = await this.http.request<unknown>({
      account: input.account,
      method: "GET",
      path: this.jobsPath(input.project),
      query: {
        allUsers: "false",
        projection: "FULL",
        maxResults,
        ...(input.stateFilter !== undefined ? { stateFilter: input.stateFilter.toUpperCase() } : {}),
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
        ...(input.minCreationTime !== undefined ? { minCreationTime: input.minCreationTime } : {}),
        ...(input.maxCreationTime !== undefined ? { maxCreationTime: input.maxCreationTime } : {}),
      },
      task: `the jobs of ${ident(input.project)}`,
      signal,
      idempotent: true,
      // The answer's HTTP Date is Google's clock when it answered (RFC 9110 §6.6.1), to the second.
      onHeaders: (headers) => {
        const parsed = Date.parse(headers.get("date") ?? "")
        if (Number.isFinite(parsed) && parsed > 0) serverTime = parsed
      },
    })
    return {
      items: itemsOf(body, "jobs").flatMap((item) => {
        const job = item as JobWire
        const jobId = job.jobReference?.jobId
        return typeof jobId === "string" ? [toJobStatus(job, { projectId: input.project, jobId, location: job.jobReference?.location ?? "" })] : []
      }),
      ...page(body),
      ...unreachableOf(body),
      ...(serverTime !== undefined ? { serverTime } : {}),
    }
  }

  async cancel(account: string, ref: JobReference, signal: AbortSignal): Promise<JobStatus> {
    const answer = await this.http.request<{ readonly job?: JobWire }>({
      account,
      method: "POST",
      path: `${this.jobsPath(ref.projectId, ref.jobId)}/cancel`,
      query: locationOf(ref.location),
      task: `the job ${ident(ref.jobId)}`,
      signal,
      idempotent: true,
      // A stop must not queue behind eight long-polls (L-2).
      priority: true,
      deadlineMs: 30_000,
    })
    if (!isRecord(answer) || !isRecord(answer.job)) throw new BigQueryError("UNAVAILABLE", `Google's cancel answer for ${ident(ref.jobId)} carried no job`)
    this.forget(account, ref)
    return toJobStatus(answer.job as JobWire, { projectId: ref.projectId, jobId: ref.jobId, location: ref.location ?? "" })
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
        ...EXACT_TIMESTAMPS,
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
      query: {
        ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
        // Without a readMask, routines.list answers no definitionBody and no arguments (…/routines/list).
        readMask: "routineType,language,remoteFunctionOptions,definitionBody,arguments",
      },
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
    const policies: { policyId: string }[] = []
    let pageToken: string | undefined
    for (let page = 0; page < POLICY_PAGES; page += 1) {
      const body = await this.http.request<unknown>({
        account,
        method: "GET",
        path: `${this.tablePath(ref)}/rowAccessPolicies`,
        query: { pageSize: 1000, ...(pageToken !== undefined ? { pageToken } : {}) },
        task: `the row access policies of ${ident(ref.projectId)}.${ident(ref.datasetId)}.${ident(ref.tableId)}`,
        signal,
        idempotent: true,
      })
      for (const item of itemsOf(body, "rowAccessPolicies")) {
        // The RowAccessPolicy resource nests the id: `rowAccessPolicyReference.policyId` (…/rowAccessPolicies). Any entry
        // is a policy, even one this version cannot read, so a policy list never silently reads as "no policy": the cap
        // rule treats any entry as row-secured (design §5.1 step 7.1).
        const reference = isRecord(item) && isRecord(item.rowAccessPolicyReference) ? item.rowAccessPolicyReference : undefined
        policies.push({ policyId: text(reference?.policyId) ?? "" })
      }
      const token = pageTokenOf(body)
      if (token === undefined || policies.length > 0) return { items: policies, ...(token !== undefined ? { nextPageToken: token } : {}) }
      // An empty page with a token is not "no policy": read on, so the answer is definitive before it says none.
      pageToken = token
    }
    // Still empty after the page bound: the list could not be read completely, so fail closed (a probe error is a plan).
    throw new BigQueryError("UNAVAILABLE", `Google's policy list for ${ident(ref.projectId)}.${ident(ref.datasetId)}.${ident(ref.tableId)} did not finish within ${POLICY_PAGES} pages`)
  }

  async testTablePermissions(account: string, ref: TableReference, permissions: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
    const body = await this.http.request<unknown>({
      account,
      method: "POST",
      // The method is a colon, not a path segment (…/tables/testIamPermissions).
      path: `${this.tablePath(ref)}:testIamPermissions`,
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
   * stopped call's signal: it gets its own short one and a priority lane, and its failure never replaces the
   * `CANCELLED` answer.
   *
   * A stop that lands while `jobs.insert` is still unanswered has no location to cancel with. The insert may have
   * created the job, so the port asks `jobs.get` for the location Google gave it and cancels again; if the job is not
   * visible, the cancel stays unpinned and may not reach a single-region job (allowed to fail visibly, ruling L8).
   */
  private async stopped(account: string, ref: JobReference, signal: AbortSignal, error: unknown): Promise<void> {
    if (!signal.aborted || !(error instanceof BigQueryError) || error.code !== "CANCELLED") return
    if (!this.started.has(this.key(account, ref))) return
    if (await this.cancelQuietly(account, ref)) return
    const located = await this.locate(account, ref)
    if (located !== undefined) await this.cancelQuietly(account, located)
  }

  private async cancelQuietly(account: string, ref: JobReference): Promise<boolean> {
    try {
      await this.cancel(account, ref, AbortSignal.timeout(15_000))
      return true
    } catch {
      return false
    }
  }

  /** The job as Google knows it, for a stop or a 409 that had no location; two short tries, then give up. */
  private async locate(account: string, ref: JobReference): Promise<JobReference | undefined> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const status = await this.getJob(account, ref, AbortSignal.timeout(10_000))
        return status.ref
      } catch {
        if (attempt === 2) return undefined
        await delay(200, AbortSignal.timeout(1_000)).catch(() => undefined)
      }
    }
    return undefined
  }

  /** The 409 join: `jobs.get`, tolerating Google's window where the job exists but is not visible yet (L-8, P14). */
  private async joined(account: string, ref: JobReference, signal: AbortSignal): Promise<JobStatus> {
    try {
      return await this.getJob(account, ref, signal)
    } catch (error) {
      if (!(error instanceof BigQueryError) || error.code !== "NOT_FOUND") throw error
      await delay(200, signal)
      return this.getJob(account, ref, signal)
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

/** `location` as a query parameter, or nothing: Google refuses an empty one, and a missing one loses a single-region job. */
function locationOf(location: string | undefined): { readonly location?: string } {
  return location === undefined || location === "" ? {} : { location }
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

/**
 * The dry run's `statistics.query`, field by field, so nothing else from Google's answer reaches the guards. A
 * referenced list with an entry that carries no ids is not a list the fence can check: the dry run is incomplete
 * (design §5.1 steps 6 and 7), never a list to guess at. The change fields (`ddlTarget*`, `dclTarget*`,
 * `ddlDestinationTable`, `ddlOperationPerformed`, `numDmlAffectedRows`) pass through from JobStatistics2
 * (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobstatistics2, read 2026-11-18) for package D's targets;
 * a target that names no project, dataset or object is incomplete too, because the fence and the asserts read it.
 */
function dryRunStatistics(statistics: {
  readonly statementType?: string
  readonly totalBytesProcessed?: string
  readonly totalBytesProcessedAccuracy?: string
  readonly referencedTables?: readonly TableReference[]
  readonly referencedLogicalViews?: readonly TableReference[]
  readonly referencedRoutines?: readonly RoutineReference[]
  readonly referencedPropertyGraphs?: readonly { readonly projectId?: string; readonly datasetId?: string; readonly propertyGraphId?: string }[]
  readonly schema?: { readonly fields?: readonly unknown[] }
  readonly ddlOperationPerformed?: string
  readonly ddlTargetTable?: Partial<TableReference>
  readonly ddlDestinationTable?: Partial<TableReference>
  readonly ddlTargetRowAccessPolicy?: { readonly projectId?: string; readonly datasetId?: string; readonly tableId?: string; readonly policyId?: string }
  readonly ddlTargetRoutine?: Partial<RoutineReference>
  readonly ddlTargetDataset?: { readonly projectId?: string; readonly datasetId?: string }
  readonly dclTargetTable?: Partial<TableReference>
  readonly dclTargetView?: Partial<TableReference>
  readonly dclTargetDataset?: { readonly projectId?: string; readonly datasetId?: string }
  readonly numDmlAffectedRows?: string
}): NonNullable<DryRunAnswer["statistics"]> {
  return {
    ...(statistics.statementType !== undefined ? { statementType: statistics.statementType } : {}),
    ...(statistics.totalBytesProcessed !== undefined ? { totalBytesProcessed: statistics.totalBytesProcessed } : {}),
    ...(accuracy(statistics.totalBytesProcessedAccuracy) !== undefined ? { totalBytesProcessedAccuracy: accuracy(statistics.totalBytesProcessedAccuracy)! } : {}),
    ...(statistics.referencedTables !== undefined ? { referencedTables: references(statistics.referencedTables, "table") } : {}),
    ...(statistics.referencedLogicalViews !== undefined ? { referencedLogicalViews: references(statistics.referencedLogicalViews, "view") } : {}),
    ...(statistics.referencedRoutines !== undefined ? { referencedRoutines: routines(statistics.referencedRoutines) } : {}),
    ...(statistics.referencedPropertyGraphs !== undefined ? { referencedPropertyGraphs: graphs(statistics.referencedPropertyGraphs) } : {}),
    ...(statistics.schema !== undefined ? { schema: statistics.schema as NonNullable<DryRunAnswer["statistics"]>["schema"] } : {}),
    ...(typeof statistics.ddlOperationPerformed === "string" ? { ddlOperationPerformed: statistics.ddlOperationPerformed } : {}),
    ...(statistics.ddlTargetTable !== undefined ? { ddlTargetTable: references([statistics.ddlTargetTable], "DDL target table")[0]! } : {}),
    ...(statistics.ddlDestinationTable !== undefined ? { ddlDestinationTable: references([statistics.ddlDestinationTable], "DDL destination table")[0]! } : {}),
    ...(statistics.ddlTargetRowAccessPolicy !== undefined ? { ddlTargetRowAccessPolicy: policyTarget(statistics.ddlTargetRowAccessPolicy) } : {}),
    ...(statistics.ddlTargetRoutine !== undefined ? { ddlTargetRoutine: routines([statistics.ddlTargetRoutine])[0]! } : {}),
    ...(statistics.ddlTargetDataset !== undefined ? { ddlTargetDataset: datasetTarget(statistics.ddlTargetDataset, "DDL target dataset") } : {}),
    ...(statistics.dclTargetTable !== undefined ? { dclTargetTable: references([statistics.dclTargetTable], "DCL target table")[0]! } : {}),
    ...(statistics.dclTargetView !== undefined ? { dclTargetView: references([statistics.dclTargetView], "DCL target view")[0]! } : {}),
    ...(statistics.dclTargetDataset !== undefined ? { dclTargetDataset: datasetTarget(statistics.dclTargetDataset, "DCL target dataset") } : {}),
    ...(typeof statistics.numDmlAffectedRows === "string" && /^\d+$/.test(statistics.numDmlAffectedRows) ? { numDmlAffectedRows: statistics.numDmlAffectedRows } : {}),
  }
}

/** A dataset target the fence can use: it names its project and dataset. */
function datasetTarget(entry: { readonly projectId?: string; readonly datasetId?: string }, what: string): { readonly projectId: string; readonly datasetId: string } {
  if (typeof entry.projectId !== "string" || typeof entry.datasetId !== "string" || entry.projectId === "" || entry.datasetId === "") {
    throw new BigQueryError("DRY_RUN_INCOMPLETE", `The dry run's ${what} names no project or dataset`)
  }
  return { projectId: entry.projectId, datasetId: entry.datasetId }
}

/** A row access policy target (RowAccessPolicyReference): its table and its policy id. */
function policyTarget(entry: { readonly projectId?: string; readonly datasetId?: string; readonly tableId?: string; readonly policyId?: string }) {
  const [table] = references([entry], "DDL target row access policy")
  if (typeof entry.policyId !== "string" || entry.policyId === "") throw new BigQueryError("DRY_RUN_INCOMPLETE", "The dry run's DDL target row access policy names no policy")
  return { ...table!, policyId: entry.policyId }
}

/** A table or view list the fence can use: every entry names its project, dataset and table. */
function references<T extends Partial<TableReference>>(list: readonly T[], what: string): readonly TableReference[] {
  return list.map((entry) => {
    if (typeof entry.projectId !== "string" || typeof entry.datasetId !== "string" || typeof entry.tableId !== "string" || entry.projectId === "" || entry.datasetId === "" || entry.tableId === "") {
      throw new BigQueryError("DRY_RUN_INCOMPLETE", `The dry run's referenced ${what} list has an entry with no project, dataset or table`)
    }
    return { projectId: entry.projectId, datasetId: entry.datasetId, tableId: entry.tableId }
  })
}

function routines(list: readonly Partial<RoutineReference>[]): readonly RoutineReference[] {
  return list.map((entry) => {
    if (typeof entry.projectId !== "string" || typeof entry.datasetId !== "string" || typeof entry.routineId !== "string" || entry.projectId === "" || entry.datasetId === "" || entry.routineId === "") {
      throw new BigQueryError("DRY_RUN_INCOMPLETE", "The dry run's referenced routine list has an entry with no project, dataset or routine")
    }
    return { projectId: entry.projectId, datasetId: entry.datasetId, routineId: entry.routineId }
  })
}

function graphs(list: readonly { readonly projectId?: string; readonly datasetId?: string; readonly propertyGraphId?: string }[]): readonly { readonly projectId: string; readonly datasetId: string; readonly propertyGraphId: string }[] {
  return list.map((entry) => {
    if (typeof entry.projectId !== "string" || typeof entry.datasetId !== "string" || typeof entry.propertyGraphId !== "string" || entry.projectId === "" || entry.datasetId === "" || entry.propertyGraphId === "") {
      throw new BigQueryError("DRY_RUN_INCOMPLETE", "The dry run's referenced property graph list has an entry with no project, dataset or graph")
    }
    return { projectId: entry.projectId, datasetId: entry.datasetId, propertyGraphId: entry.propertyGraphId }
  })
}

function accuracy(value: string | undefined): Accuracy | undefined {
  return value === "PRECISE" || value === "UPPER_BOUND" || value === "LOWER_BOUND" || value === "UNKNOWN" ? value : undefined
}

/** A list answer's page token, when Google sent one. */
/**
 * jobs.list's `unreachable[]`, "a list of skipped locations that were unreachable"
 * (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/list): a listing that skipped one is not complete for
 * it. Each entry is Google's text, so only a location-shaped one is kept as written; anything else is "unknown".
 */
function unreachableOf(body: unknown): { readonly unreachable?: readonly string[] } {
  const raw = (body as { unreachable?: unknown } | null)?.unreachable
  if (!Array.isArray(raw) || raw.length === 0) return {}
  return { unreachable: raw.slice(0, 64).map((entry) => (typeof entry === "string" && /^[A-Za-z0-9-]{1,64}$/.test(entry) ? entry : "unknown")) }
}

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
