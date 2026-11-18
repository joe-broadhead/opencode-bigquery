/**
 * The five commit tools (design §5.2): each takes a plan's id alone, then
 * 1. **acquires** the plan (single use, TTL, bound to this session, agent, account and category);
 * 2. **asserts its own `bigquery.<tool>` action** with the plan's allowlisted preview as metadata (and “Always” only
 *    where the action table says it is savable, so `bigquery_delete` never offers one);
 * 3. **requires the write level** from package A (`bigquery.insertdata` in Google's own latest refresh answer, §3.1), so
 *    no config, file or option makes a Read account commit;
 * 4. **re-runs the dry run** through package C's `prepareRead` and refuses `PLAN_CHANGED` when the type, the target set,
 *    the location, whether the cap bounds it, or an estimate more than 10 % higher differ;
 * 5. runs the statement with the plan's own cap, a client `jobId`, the labels and the plan's time limit, waits for the
 *    job, records what Google billed in the ledger, and answers the affected rows, the DDL operation, the job and the
 *    cost.
 *
 * A plan is used once: success consumes it, any refusal or failure expires it, and a job still running when the wait
 * ends keeps it consumed (the change may already be applied). Nothing runs without a plan. A job that fails is answered
 * with its bytes billed and Google's error in `googleError`, never in `message` (§5.6).
 */
import { actionOf } from "../domain/actions.js"
import { operationResource } from "../domain/accounts.js"
import type { InputOf, OutputOf } from "../domain/contract.js"
import { BigQueryError } from "../domain/errors.js"
import { requireWrite } from "../domain/levels.js"
import { type Plan, planMetadata } from "../domain/plans.js"
import type { HandlerContext } from "../registry.js"
import { asCallError } from "../guards/callerrors.js"
import { capAndBudget, usdFor } from "../guards/cost.js"
import { failureFor } from "../guards/jobfail.js"
import { prepareRead, readContext, type PreparedRead } from "../guards/read.js"
import { sessionHash } from "../guards/session.js"
import type { JobStatus, RunRequest } from "../ports.js"
import { assertTargetsFenced, classify, type Classification } from "./plan.js"
import { changeStatistics, targetsOf } from "./statistics.js"

export type CommitName = "write" | "export" | "share" | "delete" | "admin"

const CATEGORY: Readonly<Record<CommitName, "write" | "export" | "share" | "delete" | "admin">> = {
  write: "write",
  export: "export",
  share: "share",
  delete: "delete",
  admin: "admin",
}

/** How long a job may keep running while a commit waits, beyond its own time limit. */
const WAIT_MARGIN_MS = 30_000
/** At most this many long-polls; each is 30 s at most. */
const WAIT_ATTEMPTS = 20

/** A commit by its plan id, for every commit tool (`CommitInput`). */
export type CommitInputOf = InputOf<"write">

/**
 * Commits one plan with the tool that owns its category. The registry left the ports guarded until this handler asserts
 * the tool's own action, so the assert above everything else is enforced by the port proxy too.
 */
export async function commitPlan(name: CommitName, input: CommitInputOf, context: HandlerContext): Promise<OutputOf<"write">> {
  const category = CATEGORY[name]
  const plan = context.ports.plans.acquire(input.planId, {
    sessionId: context.call.sessionID,
    agentId: context.call.agent,
    account: context.account,
    category,
  })
  let consumed = false
  try {
    const entry = actionOf(name)
    const operation = entry.operation === "input" || entry.operation === "local" ? "bigquery.jobs.insert" : entry.operation
    const resource = operationResource(context.account, operation)
    await context.call.assert({
      action: entry.action,
      resources: [resource],
      // “Always” only where the action table allows it: never for a destructive plan.
      ...(entry.savable === false ? {} : { save: [resource] }),
      metadata: planMetadata(plan),
    })

    // No commit at the read level, whatever the config says: the decision is Google's grant through package A.
    const level = await context.ports.auth.level(context.account, context.call.signal)
    requireWrite(level, context.account)

    const rc = readContext({ ports: context.ports, options: context.options, account: context.account, call: context.call, via: `bigquery_${name}` })
    const prepared = await prepareRead(
      rc,
      {
        sql: plan.statement.sql,
        ...(plan.statement.params !== undefined ? { params: plan.statement.params } : {}),
        project: plan.statement.project,
        location: plan.statement.location,
        maxBytes: plan.statement.capBytes,
      },
      "inspect",
    )
    const statistics = changeStatistics(prepared.statistics)
    const freshTargets = targetsOf(statistics, prepared.statementType, statistics.referencedTables ?? [])
    // A DDL/DCL target is not in the referenced lists, so the fence is checked on it again here: the account's
    // `datasets` option may have changed between the plan and the commit.
    assertTargetsFenced(rc.settings.fence, freshTargets)
    let classification: Classification
    try {
      classification = classify(prepared, context.options, {
        requestedBytes: plan.statement.capBytes,
        ...(plan.preview.reason !== undefined ? { reason: plan.preview.reason } : {}),
      })
    } catch (error) {
      // The statement is no longer the change the plan described: a read now, or another kind of change. That is the
      // plan-changed condition, not a request to use another tool.
      if (error instanceof BigQueryError && error.code === "CATEGORY_MISMATCH") {
        throw new BigQueryError("PLAN_CHANGED", "The statement is no longer a change of the kind the plan described", "Plan again and show the user the new preview.")
      }
      throw error
    }
    const drift = changed(plan, prepared, classification, freshTargets)
    if (drift !== undefined) {
      throw new BigQueryError("PLAN_CHANGED", drift, "Plan again and show the user the new preview.")
    }

    // The preview's promise, checked again: the estimate must still fit the plan's cap.
    if (prepared.bytes > plan.statement.capBytes) {
      throw new BigQueryError(
        "COST_CAP",
        `The estimate is now ${prepared.bytes} bytes and the plan's cap is ${plan.statement.capBytes} bytes`,
        "Plan again, so the user sees the new estimate and cap.",
      )
    }
    // A cap that cannot bound the statement is bounded by the time limit and the budget; re-read the ledger so a budget
    // spent between plan and commit still refuses (design §6.2 item 4).
    if (!plan.statement.capEnforceable && context.options.budget !== undefined) {
      const budget = await capAndBudget({
        options: context.options,
        ports: context.ports,
        account: context.account,
        session: sessionHash(context.call.sessionID),
        now: context.ports.clock.now(),
        estimateBytes: prepared.bytes,
        requested: plan.statement.capBytes,
      })
      if (budget.capBytes < plan.statement.capBytes) {
        throw new BigQueryError(
          "BUDGET_REACHED",
          `The budget no longer leaves the plan's cap of ${plan.statement.capBytes} bytes; it leaves ${budget.capBytes}`,
          "Wait for the budget to reset, or ask the user to raise the budget option.",
        )
      }
    }

    const jobId = `oc_${context.ports.clock.uuid()}`
    const session = sessionHash(context.call.sessionID)
    const labels = { oc_plugin: "opencode-bigquery", oc_tool: labelOf(`bigquery_${name}`), oc_session: session }
    const request: RunRequest = {
      account: context.account,
      project: prepared.project,
      sql: plan.statement.sql,
      ...(prepared.params !== undefined ? { params: prepared.params } : {}),
      ...(prepared.defaultDataset !== undefined ? { defaultDataset: prepared.defaultDataset } : {}),
      location: prepared.location,
      useQueryCache: false,
      jobId,
      maximumBytesBilled: plan.statement.capBytes,
      jobTimeoutMs: plan.statement.jobTimeoutSeconds * 1000,
      labels,
    }

    let status: JobStatus
    try {
      status = await context.ports.bigquery.run(request, context.call.signal)
    } catch (error) {
      const failure = asCallError(error, "The change job did not start")
      const job = { project: prepared.project, jobId, location: prepared.location }
      // A stopped call: the job may have been created, so the plan is used and the answer does not claim a state.
      if (failure.code === "CANCELLED") {
        context.ports.plans.complete(plan.id)
        consumed = true
        return { state: "cancelled", category, job, message: "The commit was stopped; the change may or may not have been applied", next: jobNext(job) }
      }
      // A 5xx or a transport failure may have created the job (design §8): answer running with the client id, and keep
      // the plan consumed, so the change is never sent twice.
      if (failure.code === "UNAVAILABLE") {
        context.ports.plans.complete(plan.id)
        consumed = true
        return {
          state: "running",
          category,
          job,
          message: "The request did not answer, so the job may have started",
          next: jobNext(job),
        }
      }
      throw failure
    }

    const deadline = context.ports.clock.now() + plan.statement.jobTimeoutSeconds * 1000 + WAIT_MARGIN_MS
    let waited: Awaited<ReturnType<typeof awaitJob>>
    try {
      waited = await awaitJob(context, status, deadline)
    } catch (error) {
      const failure = asCallError(error, "The job's state could not be read")
      if (failure.code === "CANCELLED") {
        context.ports.plans.complete(plan.id)
        consumed = true
        const job = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? prepared.location }
        return { state: "cancelled", category, job, message: "The commit was stopped; the change may or may not have been applied", next: jobNext(job) }
      }
      throw failure
    }
    status = waited.status
    const job = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? prepared.location }
    await record(context, { status, plan, via: `bigquery_${name}`, session })

    if (!waited.done) {
      context.ports.plans.complete(plan.id)
      consumed = true
      return { state: "running", category, job, ...costOf(status, context), next: jobNext(job) }
    }
    const failure = failureFor(status)
    if (failure !== undefined) {
      return {
        state: failure.state === "cancelled" ? "cancelled" : "failed",
        error: failure.code,
        message: failure.detail,
        next: failure.next,
        job,
        ...costOf(status, context),
        ...(failure.extras.googleError !== undefined ? { googleError: failure.extras.googleError } : {}),
      }
    }
    if (status.statementType !== undefined && status.statementType !== plan.statement.statementType) {
      return {
        state: "failed",
        error: "CLASSIFICATION_DRIFT",
        message: `The job ran as ${plain(status.statementType)}, and the plan was made for ${plan.statement.statementType}`,
        next: "bigquery_jobs shows what ran; report it.",
        job,
        ...costOf(status, context),
      }
    }

    context.ports.plans.complete(plan.id)
    consumed = true
    const affected = status.numDmlAffectedRows !== undefined ? Number(status.numDmlAffectedRows) : undefined
    return {
      state: "done",
      category,
      job,
      ...(finite(affected) ? { affectedRows: affected } : {}),
      ...(status.ddlOperationPerformed !== undefined ? { ddlOperation: status.ddlOperationPerformed } : {}),
      ...costOf(status, context),
    }
  } finally {
    // A refusal, a failed job or a changed plan expires the plan: it never comes back. A stopped or ambiguous call keeps
    // it used, because the change may already have been applied.
    if (!consumed) context.ports.plans.release(plan.id)
  }
}

/** Whether two plans differ in a way design §5.2 calls `PLAN_CHANGED`. */
function changed(plan: Plan, prepared: PreparedRead, classification: Classification, freshTargets: ReturnType<typeof targetsOf>): string | undefined {
  if (classification.category !== plan.category) {
    return `The statement now classifies as ${classification.category}, and the plan was made as ${plan.category}`
  }
  if (prepared.statementType !== plan.statement.statementType) {
    return `The statement now parses as ${prepared.statementType}, and the plan was made for ${plan.statement.statementType}`
  }
  const fresh = freshTargets.map((target) => target.label)
  if (!sameSet(fresh, plan.statement.targets)) return "The statement's targets changed since the plan was made"
  if (prepared.location !== plan.statement.location) return "The statement's location changed since the plan was made"
  if (classification.capEnforceable !== plan.statement.capEnforceable) {
    return "Whether the byte cap bounds the statement changed since the plan was made"
  }
  if (prepared.bytes > plan.statement.estimateBytes * 1.1) return "The statement's estimate grew more than 10 percent since the plan was made"
  return undefined
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Long-poll a started job with `getQueryResults`, then read its final state; a DDL job may have no results to page. */
async function awaitJob(context: HandlerContext, started: JobStatus, deadline: number): Promise<{ status: JobStatus; done: boolean }> {
  let status = started
  for (let attempt = 0; status.state !== "DONE" && attempt < WAIT_ATTEMPTS; attempt += 1) {
    const remaining = deadline - context.ports.clock.now()
    if (remaining <= 0) break
    try {
      await context.ports.bigquery.results(context.account, status.ref, { timeoutMs: Math.min(30_000, remaining), maxResults: 1 }, context.call.signal)
    } catch {
      // A DDL job has no result table; jobs.get below is the authority on what happened.
    }
    status = await context.ports.bigquery.getJob(context.account, status.ref, context.call.signal)
  }
  return { status, done: status.state === "DONE" }
}

/** Record what the job actually billed, by job id, under the cross-process lock (design §6.2 item 4). */
async function record(context: HandlerContext, input: { status: JobStatus; plan: Plan; via: string; session: string }): Promise<void> {
  const billed = input.status.totalBytesBilled ?? 0
  if (billed <= 0) return
  try {
    await context.ports.ledger.record({
      at: new Date(input.status.endTime ?? context.ports.clock.now()).toISOString(),
      account: context.account,
      project: input.status.ref.projectId,
      location: input.status.ref.location ?? input.plan.statement.location,
      jobId: input.status.ref.jobId,
      bytesBilled: billed,
      via: input.via,
      session: input.session,
    })
  } catch {
    // The change already ran and billed; a ledger write that fails must not hide its result.
  }
}

function costOf(status: JobStatus, context: HandlerContext): Record<string, number | boolean> {
  return {
    ...(status.totalBytesProcessed !== undefined ? { bytesProcessed: status.totalBytesProcessed } : {}),
    ...(status.totalBytesBilled !== undefined ? { bytesBilled: status.totalBytesBilled } : {}),
    ...(status.totalBytesBilled !== undefined ? { costUsd: usdFor(status.totalBytesBilled, context.options) } : {}),
    ...(status.cacheHit !== undefined ? { cacheHit: status.cacheHit } : {}),
  }
}

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value)

/** A validated identifier for a `next`: a plain name, otherwise `object`. */
const plain = (value: string) => (/^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "another type")

const jobNext = (job: { readonly project: string; readonly jobId: string; readonly location: string }) =>
  `bigquery_job({ project: ${quote(job.project)}, jobId: ${quote(job.jobId)}, location: ${quote(job.location)}, wait: 30 })`

const quote = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`")

/** A label value: lowercase letters, digits, underscores and dashes, at most 63. */
const labelOf = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63) || "tool"
