/**
 * Package E: `bigquery_save` (design §7). It asserts its own action, then OpenCode's `edit` (and `external_directory`
 * outside the project), streams a **finished** query job's result table into a local CSV, JSONL or Parquet file, and
 * answers `charts: { path, format, rows, fitsCharts }` for the charts plugin. Allowed at every level: it writes only
 * locally (`export` class, not a change).
 *
 * The fence is checked over the objects `jobs.get` names, exactly as `bigquery_job` does before it shows a row: a job
 * over a fenced dataset is not saved to a file, and a cache hit that names nothing cannot be checked, so it is refused
 * under a fence. The per-object assert (`bigquery.save` on `<account>:table:<project>.<dataset>.<name>`) makes a
 * person's own rule fence too (design §5.4).
 *
 * Google's free calls only: `jobs.get` and `getQueryResults` paging. A result table expires 24 hours after the original
 * run, and a missing one is `RESULTS_EXPIRED`.
 */
import { failureFor } from "../guards/jobfail.js"
import { assertFenced, type FenceObject } from "../guards/fence.js"
import { assertObjectResources } from "../guards/read.js"
import { locationOf, projectOf, settingsOf } from "../guards/settings.js"
import { BigQueryError } from "../domain/errors.js"
import { operationResource } from "../domain/accounts.js"
import type { OutputOf } from "../domain/contract.js"
import type { JobStatus, ResultPage } from "../ports.js"
import type { Handlers } from "../registry.js"
import { convertRows, FileWriter, resolveTarget, assertEdit, SAVE_PAGE_ROWS } from "../files/index.js"

/** What OpenCode may save for: the charts plugin reads CSV, JSON, JSONL and Parquet up to 100,000 rows and 32 MB. */
const CHART_ROWS = 100_000
const CHART_BYTES = 32 * 1024 * 1024

const jobNext = (job: { readonly project: string; readonly jobId: string; readonly location: string }) =>
  `bigquery_job({ project: ${plain(job.project)}, jobId: ${plain(job.jobId)}, location: ${plain(job.location)}, wait: 30 })`

/** A validated identifier for a `next`, in backquotes; anything else is `object`. */
const plain = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`")

/** The objects a job names, as the fence and the per-table assert see them. */
function jobObjects(status: JobStatus): FenceObject[] {
  const out: FenceObject[] = []
  for (const ref of status.referencedTables ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "table" })
  for (const ref of status.referencedLogicalViews ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "view" })
  for (const ref of status.referencedRoutines ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.routineId, kind: "routine" })
  return out
}

const expired = () => new BigQueryError("RESULTS_EXPIRED", "The job's result table is gone", "Run the query again; a result table expires 24 hours after the original run.")

const save: Handlers["save"] = async (input, context) => {
  const account = context.account
  const settings = settingsOf(context.options, account)
  const project = projectOf(settings, input.project)
  const location = locationOf(settings, input.location)
  const signal = context.call.signal

  // Its own action first: the guarded ports refuse any request before this assert. The save patterns let "Always" cover
  // the same operation, as every tool's own assert does.
  const operation = operationResource(account, "bigquery.jobs.getQueryResults")
  await context.call.assert({
    action: "bigquery.save",
    resources: [operation],
    save: [operation],
    metadata: { account, project, jobId: input.jobId, format: input.format },
  })

  // The path and OpenCode's file permissions come before any Google call: a refused path costs nothing.
  const target = resolveTarget(
    { path: input.path, ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}) },
    context.options,
  )
  await assertEdit(target, context.call)

  const ref = { projectId: project, jobId: input.jobId, ...(location !== undefined ? { location } : {}) }
  let status: JobStatus
  try {
    status = await context.ports.bigquery.getJob(account, ref, signal)
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") throw expired()
    throw error
  }
  const job = { project: status.ref.projectId || project, jobId: status.ref.jobId, location: status.ref.location ?? location ?? "" }
  if (status.state !== "DONE") {
    return { state: "running", job, next: jobNext(job) }
  }
  const failure = failureFor(status)
  if (failure) throw failure

  const objects = jobObjects(status)
  const blind = status.cacheHit === true && objects.length === 0
  if (blind && (settings.fence?.allow !== undefined || settings.fence?.deny !== undefined)) {
    throw new BigQueryError(
      "DATASET_FENCED",
      "The job's result came from the query cache, so BigQuery names none of the objects it read and the account's dataset fence cannot be checked",
      "Run the query with bigquery_query, which checks it before it runs.",
    )
  }
  assertFenced(settings.fence, objects)
  await assertObjectResources({ call: context.call, account, action: "bigquery.save", via: "bigquery_save", objects })

  let page: ResultPage
  try {
    page = await context.ports.bigquery.results(account, status.ref, { timeoutMs: 0, maxResults: SAVE_PAGE_ROWS }, signal)
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") throw expired()
    throw error
  }
  const schema = page.schema ?? []
  const writer = new FileWriter(target.path, input.format, schema, { maxRows: context.options.maxSaveRows, maxBytes: context.options.maxSaveBytes })
  try {
    writer.write(convertRows(schema, page.rows))
    while (page.pageToken !== undefined) {
      page = await context.ports.bigquery.results(
        account,
        status.ref,
        { timeoutMs: 0, maxResults: SAVE_PAGE_ROWS, pageToken: page.pageToken },
        signal,
      )
      writer.write(convertRows(schema, page.rows))
    }
    const written = writer.finish()
    const fitsCharts = written.rows <= CHART_ROWS && written.bytes <= CHART_BYTES
    const out: OutputOf<"save"> = {
      state: "done",
      path: target.path,
      rows: written.rows,
      bytes: written.bytes,
      sha256: written.sha256,
      charts: { path: target.path, format: input.format, rows: written.rows, fitsCharts },
      ...(fitsCharts
        ? {}
        : { next: `The file is over what the charts plugin reads (${CHART_ROWS} rows or 32 MB); narrow the query, or read it with a program of your own.` }),
    }
    return out
  } catch (error) {
    writer.abort()
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") throw expired()
    throw error
  }
}

export const FILE_HANDLERS: Pick<Handlers, "save"> = { save }
