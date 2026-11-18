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
import { failureFor } from "../guards/jobfail.js"
import { locationOf, projectOf, settingsOf } from "../guards/settings.js"
import type { Handlers } from "../registry.js"
import { commitPlan } from "../changes/commit.js"
import { plan } from "../changes/plan.js"

/** A validated identifier for a `next`: a plain name, otherwise `object`. */
const plain = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`")

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

  const status = await context.ports.bigquery.cancel(context.account, ref, context.call.signal)
  const job = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? location ?? "" }
  const next = `bigquery_job({ project: ${plain(job.project)}, jobId: ${plain(job.jobId)}, location: ${plain(job.location)}, wait: 30 })`
  const failure = failureFor(status)
  // A job Google already stopped or cancelled is this tool's outcome, not a failure: answer cancelled without an error.
  if (failure !== undefined && failure.code !== "CANCELLED") {
    return {
      state: failure.state === "cancelled" ? "cancelled" : "failed",
      error: failure.code,
      message: failure.detail,
      next: failure.next,
      job,
      billed: "unknown",
      ...(failure.extras.googleError !== undefined ? { googleError: failure.extras.googleError } : {}),
    }
  }
  // jobs.cancel “will return immediately, and the client will need to poll for the job status to see if the cancel
  // completed” (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel, read 18 Nov 2026).
  if (failure === undefined && status.state === "DONE") {
    return { state: "done", job, jobState: status.state, billed: "unknown", message: "The job had already finished, so nothing was cancelled", next }
  }
  return { state: "cancelled", job, jobState: status.state, billed: "unknown", next }
}

export const CHANGE_HANDLERS: Pick<Handlers, "plan" | "write" | "export" | "share" | "delete" | "admin" | "cancel"> = {
  plan,
  write: (input, context) => commitPlan("write", input, context),
  export: (input, context) => commitPlan("export", input, context),
  share: (input, context) => commitPlan("share", input, context),
  delete: (input, context) => commitPlan("delete", input, context),
  admin: (input, context) => commitPlan("admin", input, context),
  cancel,
}
