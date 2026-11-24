/**
 * Package D's tools (design §5.2): `bigquery_plan`, the five commit tools and `bigquery_cancel`.
 *
 * `bigquery_plan` is a read: the registry asserts it before the handler, and `src/changes/plan.ts` dry-runs the change
 * and returns a single-use preview. The five commits are changes: each asserts its own `bigquery.<tool>` action in
 * `src/changes/commit.ts` with its plan's allowlisted preview, checks the write level, re-runs the dry run and refuses a
 * changed plan, then runs with the plan's cap. `bigquery_cancel` is a change too, but runs on either level: it stops a
 * job IAM lets this account cancel, and asserts before its one request.
 */
import { actionOf } from "../domain/actions.js"
import { operationResource } from "../domain/accounts.js"
import { BigQueryError } from "../domain/errors.js"
import { failureFor } from "../guards/jobfail.js"
import { locationOf, projectOf, settingsOf } from "../guards/settings.js"
import type { Handlers } from "../registry.js"
import { commitPlan } from "../changes/commit.js"
import { plan } from "../changes/plan.js"

/** A validated identifier for a `next`: a plain name, otherwise `object`. */
const plain = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`")

/** The label every job this plugin starts carries (design §6.2 item 7). */
const PLUGIN_LABEL = "bigquery-plugin"
/** The `oc_tool` labels of the plugin's read jobs: a Read account may cancel only these. */
const READ_JOB_TOOLS = new Set(["bigquery_query", "bigquery_profile", "bigquery_table", "bigquery_search", "saved_read"])

/** A label value for a message: only the plugin's own lowercase labels, otherwise a generic name. */
const toolLabel = (value: string | undefined) => (value !== undefined && /^[a-z0-9_-]{1,63}$/.test(value) ? value : "a job this plugin started")

const cancel: NonNullable<Handlers["cancel"]> = async (input, context) => {
  const settings = settingsOf(context.options, context.account)
  const project = projectOf(settings, input.project)
  const location = locationOf(settings, input.location)
  const ref = { projectId: project, jobId: input.jobId, ...(location !== undefined ? { location } : {}) }
  const cancelAction = actionOf("cancel")
  const resource = operationResource(context.account, cancelAction.operation === "input" ? "bigquery.jobs.cancel" : String(cancelAction.operation))
  await context.call.assert({
    action: cancelAction.action,
    resources: [resource],
    save: [resource],
    metadata: { account: context.account, project, jobId: input.jobId, ...(location !== undefined ? { location } : {}) },
  })

  // Only a job this plugin started: the plugin's own `oc_` job id and its server-side label. A Read account may cancel
  // only the plugin's read jobs; anything else is someone's scheduled query or ETL (review bigquery-8 H-2).
  const level = await context.ports.auth.level(context.account, context.call.signal)
  const found = await context.ports.bigquery.getJob(context.account, ref, context.call.signal)
  const labels = found.labels ?? {}
  if (labels.oc_plugin !== PLUGIN_LABEL || !found.ref.jobId.startsWith("oc_")) {
    throw new BigQueryError(
      "PERMISSION_DENIED",
      `The job ${plain(found.ref.jobId)} was not started by this plugin`,
      "bigquery_jobs lists the jobs this account started; cancel only a job with the plugin's label, or use the Google Cloud console.",
    )
  }
  if (level.level !== "write" && !READ_JOB_TOOLS.has(labels.oc_tool ?? "")) {
    throw new BigQueryError(
      "PERMISSION_DENIED",
      `The account ${context.account} has the Read level, so it cancels only this plugin's read jobs; this is ${toolLabel(labels.oc_tool)}`,
      "Cancel a write job with a Read and write account, or use the Google Cloud console.",
    )
  }
  const shown = { project: found.ref.projectId, jobId: found.ref.jobId, location: found.ref.location ?? location ?? "" }
  const next = `bigquery_job({ project: ${plain(shown.project)}, jobId: ${plain(shown.jobId)}, location: ${plain(shown.location)}, wait: 30 })`
  // A finished job needs no cancel: report what it ended as, and do not call jobs.cancel at all. A job Google already
  // stopped is the outcome the caller wanted, not a failure.
  const finished = failureFor(found)
  if (finished !== undefined && finished.code !== "CANCELLED") {
    return {
      state: "failed",
      error: finished.code,
      message: finished.detail,
      next: finished.next,
      job: shown,
      billed: "unknown",
      ...(finished.extras.googleError !== undefined ? { googleError: finished.extras.googleError } : {}),
    }
  }
  if (finished !== undefined || found.state === "DONE") {
    return {
      state: finished !== undefined ? "cancelled" : "done",
      job: shown,
      jobState: found.state,
      billed: "unknown",
      ...(finished === undefined ? { message: "The job had already finished, so nothing was cancelled" } : {}),
      next,
    }
  }

  const status = await context.ports.bigquery.cancel(context.account, ref, context.call.signal)
  const job = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? location ?? "" }
  const completed = failureFor(status)
  // A job Google already stopped or cancelled is this tool's outcome, not a failure: answer cancelled without an error.
  if (completed !== undefined && completed.code !== "CANCELLED") {
    return {
      state: completed.state === "cancelled" ? "cancelled" : "failed",
      error: completed.code,
      message: completed.detail,
      next: completed.next,
      job,
      billed: "unknown",
      ...(completed.extras.googleError !== undefined ? { googleError: completed.extras.googleError } : {}),
    }
  }
  // jobs.cancel “will return immediately, and the client will need to poll for the job status to see if the cancel
  // completed” (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel, read 18 Nov 2026).
  if (completed === undefined && status.state === "DONE") {
    return { state: "done", job, jobState: status.state, billed: "unknown", message: "The job had already finished, so nothing was cancelled", next: jobNextOf(job) }
  }
  return { state: "cancelled", job, jobState: status.state, billed: "unknown", next: jobNextOf(job) }
}

/** `bigquery_job` for a job, from validated identifiers. */
const jobNextOf = (job: { readonly project: string; readonly jobId: string; readonly location: string }) =>
  `bigquery_job({ project: ${plain(job.project)}, jobId: ${plain(job.jobId)}, location: ${plain(job.location)}, wait: 30 })`

export const CHANGE_HANDLERS: Pick<Handlers, "plan" | "write" | "export" | "share" | "delete" | "admin" | "cancel"> = {
  plan,
  write: (input, context) => commitPlan("write", input, context),
  export: (input, context) => commitPlan("export", input, context),
  share: (input, context) => commitPlan("share", input, context),
  delete: (input, context) => commitPlan("delete", input, context),
  admin: (input, context) => commitPlan("admin", input, context),
  cancel,
}
