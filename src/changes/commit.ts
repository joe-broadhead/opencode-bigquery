/**
 * The five commit methods and the uncapped read's runner (design §5.2). Each takes the plan the register kept as
 * `call.plan` and has already reserved and spent once (contract §6); here the statement is re-checked against that plan
 * with a fresh dry run, and only then run.
 *
 * 1. **require the write level** from the auth port (`bigquery.insertdata` in Google's own latest refresh answer, §3.1),
 *    so no option makes a Read account commit;
 * 2. **re-run the dry run** through `prepareRead` and refuse `PLAN_CHANGED` when the type, the target set, the location,
 *    whether the cap bounds it, or an estimate more than 10 % higher differ;
 * 3. run the statement with the plan's own cap, a client `jobId`, the labels and the plan's time limit, wait for the job,
 *    record what Google billed in the ledger, and answer the affected rows, the DDL operation, the job and the cost.
 *
 * A failed job's own code and next step are the refusal, and what it billed is in the message: a commit never hides a
 * cost. Nothing runs without a plan.
 */
import { type Category, COMMITTER } from "../constants.js";
import { BigQueryError } from "../domain/errors.js";
import { requireWrite } from "../domain/levels.js";
import type { PlannedChange, PlannedRead, PlannedStatement } from "../domain/plans.js";
import { asCallError } from "../guards/callerrors.js";
import { capAndBudget, usdFor } from "../guards/cost.js";
import { failureFor } from "../guards/jobfail.js";
import { type PreparedRead, prepareRead, type ReadRun, readContext, runRead } from "../guards/read.js";
import { sessionHash } from "../guards/session.js";
import type { HandlerContext } from "../handlers/context.js";
import type { JobStatus, RunRequest } from "../ports.js";
import { assertTargetsFenced, type Classification, checkTargets, classify, hasFence } from "./plan.js";
import { type ScriptStatementInput, sameScript, scriptStatements } from "./scripts.js";
import { statementSources, statementTarget } from "./statement-target.js";
import { changeTargets, sameTargets, type Target, targetsOf, unionTargets } from "./statistics.js";

/** How long a job may keep running while a commit waits, beyond its own time limit. */
const WAIT_MARGIN_MS = 30_000;
/** At most this many long-polls; each is 30 s at most. */
const WAIT_ATTEMPTS = 20;

/** A commit's answer: the job, the cost, and what the change did. */
export interface CommitAnswer {
  readonly state: "done" | "running";
  readonly category: Category;
  readonly job: { readonly project: string; readonly jobId: string; readonly location: string };
  readonly bytesProcessed?: number;
  readonly bytesBilled?: number;
  readonly costUsd?: number;
  readonly cacheHit?: boolean;
  readonly affectedRows?: number;
  readonly ddlOperation?: string;
  readonly next?: string;
  readonly trust: "untrusted";
}

/** Commits one plan with the method that owns its class, or refuses `PLAN_CHANGED`. */
export async function commitChange(category: Category, plan: PlannedChange, context: HandlerContext): Promise<CommitAnswer> {
  if (plan.category !== category) {
    throw new BigQueryError("PLAN_CHANGED", `The plan is a ${plan.category} plan, and ${COMMITTER[category]} commits ${category} plans`, "Plan the change again with its own planner, then commit with the method it names.");
  }
  // No commit at the read level, whatever the config says: the decision is Google's grant through the auth port.
  const level = await context.ports.auth.level(context.account, context.signal);
  requireWrite(level, context.account);

  const statement = plan.statement;
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: COMMITTER[category] });
  const prepared = await prepareRead(
    rc,
    {
      sql: statement.sql,
      ...(statement.params !== undefined ? { params: statement.params } : {}),
      project: statement.project,
      location: statement.location,
      maxBytes: statement.capBytes,
    },
    "inspect",
  );
  const statistics = prepared.statistics;
  const wholeTargets = targetsOf(statistics, prepared.statementType, statistics.referencedTables ?? []);
  let freshTargets: Target[];
  if (prepared.statementType === "SCRIPT") {
    if (plan.script === undefined) {
      throw new BigQueryError("PLAN_CHANGED", "The plan has no record of the script's statements, so the commit cannot re-check them", "Plan again and show the person the new preview.");
    }
    const freshScript = await scriptStatements({
      ports: context.ports,
      account: context.account,
      project: prepared.project,
      location: prepared.location,
      ...(prepared.params !== undefined ? { params: prepared.params } : {}),
      signal: context.signal,
      sql: statement.sql,
    });
    for (const entry of freshScript) {
      if (!entry.determined) {
        if (hasFence(rc.settings.fence)) {
          throw new BigQueryError(
            "DATASET_FENCED",
            "One of the script's statements could not be dry-run on its own, so its target cannot be verified against the account's dataset fence",
            "Split the script into statements, replace variables or temporary tables with dataset tables, or ask the person to remove the fence.",
          );
        }
        continue;
      }
      if (entry.sourceMissing && hasFence(rc.settings.fence)) {
        throw new BigQueryError(
          "DATASET_FENCED",
          "One of the script's statements copies or clones a table whose source cannot be verified against the account's dataset fence",
          "Name the CLONE or COPY source with a project, dataset and table (backquoted where it needs to be), or ask the person to remove the fence.",
        );
      }
      checkTargets(rc.settings.fence, entry.type, entry.targets, "statement");
      assertTargetsFenced(rc.settings.fence, entry.references);
    }
    assertTargetsFenced(rc.settings.fence, wholeTargets);
    // The plan's statements are the original ScriptStatementInput values the planner recorded (the register keeps a copy).
    if (!sameScript(plan.script.statements as unknown as readonly ScriptStatementInput[], freshScript)) {
      throw new BigQueryError("PLAN_CHANGED", "The script's statements changed since the plan was made", "Plan again and show the person the new preview.");
    }
    freshTargets = unionTargets(wholeTargets, ...freshScript.map((entry) => entry.targets));
  } else {
    const sources = statementSources(statement.sql, prepared.statementType, prepared.project);
    if (sources.required && sources.targets.length === 0 && hasFence(rc.settings.fence)) {
      throw new BigQueryError(
        "DATASET_FENCED",
        "The source of the statement's CLONE or COPY clause cannot be verified against the account's dataset fence",
        "Name the source with a project, dataset and table (backquoted where it needs to be), or ask the person to remove the fence.",
      );
    }
    freshTargets = changeTargets(wholeTargets, statementTarget(statement.sql, prepared.statementType, prepared.project), sources.targets);
    checkTargets(rc.settings.fence, prepared.statementType, freshTargets, "statement");
  }
  let classification: Classification;
  try {
    classification = classify(prepared, context.options, {
      requestedBytes: statement.capBytes,
      ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
    });
  } catch (error) {
    // The statement is no longer the change the plan described: a read now, or another kind of change.
    if (error instanceof BigQueryError && error.code === "CATEGORY_MISMATCH") {
      throw new BigQueryError("PLAN_CHANGED", "The statement is no longer a change of the kind the plan described", "Plan again and show the person the new preview.");
    }
    throw error;
  }
  const drift = changed(category, statement, prepared, classification, freshTargets);
  if (drift !== undefined) throw new BigQueryError("PLAN_CHANGED", drift, "Plan again and show the person the new preview.");

  // The preview's promise, checked again: the estimate must still fit the plan's cap.
  if (prepared.bytes > statement.capBytes) {
    throw new BigQueryError("COST_CAP", `The estimate is now ${prepared.bytes} bytes and the plan's cap is ${statement.capBytes} bytes`, "Plan again, so the person sees the new estimate and cap.");
  }
  // A cap that cannot bound the statement is bounded by the time limit and the budget; re-read the ledger so a budget
  // spent between plan and commit still refuses (design §6.2 item 4).
  if (!statement.capEnforceable && context.options.budget !== undefined) {
    const budget = await capAndBudget({
      options: context.options,
      ports: context.ports,
      account: context.account,
      session: sessionHash(context.sessionID),
      now: context.ports.clock.now(),
      estimateBytes: prepared.bytes,
      requested: statement.capBytes,
    });
    if (budget.capBytes < statement.capBytes) {
      throw new BigQueryError("BUDGET_REACHED", `The budget no longer leaves the plan's cap of ${statement.capBytes} bytes; it leaves ${budget.capBytes}`, "Wait for the budget to reset, or ask the person to raise the budget option.");
    }
  }

  const jobId = `oc_${context.ports.clock.uuid()}`;
  const session = sessionHash(context.sessionID);
  const labels = { oc_plugin: "bigquery-plugin", oc_tool: labelOf(COMMITTER[category]), oc_session: session };
  const request: RunRequest = {
    account: context.account,
    project: prepared.project,
    sql: statement.sql,
    ...(prepared.params !== undefined ? { params: prepared.params } : {}),
    ...(prepared.defaultDataset !== undefined ? { defaultDataset: prepared.defaultDataset } : {}),
    location: prepared.location,
    useQueryCache: false,
    jobId,
    maximumBytesBilled: statement.capBytes,
    jobTimeoutMs: statement.jobTimeoutSeconds * 1000,
    labels,
  };

  let status: JobStatus;
  try {
    status = await context.ports.bigquery.run(request, context.signal);
  } catch (error) {
    const failure = asCallError(error, "The change job did not start");
    const job = { project: prepared.project, jobId, location: prepared.location };
    // A stopped call: the job may have been created, so the answer does not claim a state.
    if (failure.code === "CANCELLED") throw new BigQueryError("CANCELLED", `The commit was stopped; the change may or may not have been applied (job ${jobId})`, `Check jobs before planning the change again.`);
    // A 5xx or a transport failure may have created the job (design §8): the change is never sent twice.
    if (failure.code === "UNAVAILABLE") throw new BigQueryError("UNAVAILABLE", `The request did not answer, so the change job may have started (job ${jobId})`, `Check jobs for ${jobId} before planning the change again.`);
    throw failure;
  }

  const deadline = context.ports.clock.now() + statement.jobTimeoutSeconds * 1000 + WAIT_MARGIN_MS;
  status = await awaitJob(context, status, deadline);
  const job = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? prepared.location };
  await record(context, { status, location: statement.location, via: COMMITTER[category], session });

  if (status.state !== "DONE") {
    return { state: "running", category, job, ...costOf(status, context), next: jobNext(job), trust: "untrusted" };
  }
  const failure = failureFor(status);
  if (failure !== undefined) {
    const billed = status.totalBytesBilled ?? 0;
    throw new BigQueryError(failure.code, `${failure.detail}${billed > 0 ? `, and ${billed} bytes were billed` : ""}`, failure.next);
  }
  if (status.statementType !== undefined && status.statementType !== statement.statementType) {
    throw new BigQueryError("CLASSIFICATION_DRIFT", `The job ran as ${status.statementType}, and the plan was made for ${statement.statementType}`, "jobs shows what ran; report it.");
  }

  const affected = status.numDmlAffectedRows !== undefined ? Number(status.numDmlAffectedRows) : undefined;
  return {
    state: "done",
    category,
    job,
    ...(Number.isFinite(affected) ? { affectedRows: affected } : {}),
    ...(status.ddlOperationPerformed !== undefined ? { ddlOperation: status.ddlOperationPerformed } : {}),
    ...costOf(status, context),
    trust: "untrusted",
  };
}

/**
 * `run_query`: an uncapped-read plan the person previewed. The statement is re-checked against the plan (its type, its
 * location, no new external effect, an estimate no more than 10 % higher) and runs with the plan's cap and the shorter
 * limit a cap-unenforceable read gets.
 */
export async function runPlannedRead(plan: PlannedRead, context: HandlerContext): Promise<ReadRunAnswer> {
  if (context.options.uncappedReads === "refuse") {
    throw new BigQueryError("CAP_NOT_ENFORCEABLE", "This account refuses reads the byte cap cannot bound", "Narrow the query to native tables without row access policies, or ask the person to set uncappedReads to ask.");
  }
  const statement = plan.statement;
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: "run_query" });
  const prepared = await prepareRead(
    rc,
    {
      sql: statement.sql,
      ...(statement.params !== undefined ? { params: statement.params } : {}),
      project: statement.project,
      location: statement.location,
      maxBytes: statement.capBytes,
    },
    "inspect",
  );
  if (prepared.statementType !== statement.statementType) {
    throw new BigQueryError("PLAN_CHANGED", "The statement's type changed since the plan was made", "Plan again and show the person the new preview.");
  }
  if (prepared.kind !== "read" || prepared.effects.length > 0) {
    throw new BigQueryError("PLAN_CHANGED", "The statement is no longer a side-effect-free read", "Plan again and show the person the new preview.");
  }
  if (prepared.location !== statement.location) {
    throw new BigQueryError("PLAN_CHANGED", "The statement's location changed since the plan was made", "Plan again and show the person the new preview.");
  }
  if (prepared.bytes > statement.estimateBytes * 1.1) {
    throw new BigQueryError("PLAN_CHANGED", "The statement's estimate grew more than 10 percent since the plan was made", "Plan again and show the person the new preview.");
  }
  const run = await runRead(rc, prepared, {
    maxRows: context.options.maxRows,
    waitSeconds: 30,
    maxBytes: statement.capBytes,
    timeoutSeconds: Math.min(statement.jobTimeoutSeconds, context.options.uncappedTimeoutSeconds),
  });
  return queryResult(prepared, run);
}

/** A read's answer: the columns and rows, the job, and what it cost. */
export interface ReadRunAnswer {
  readonly state: "done" | "running";
  readonly columns?: readonly { readonly name: string; readonly type: string }[];
  readonly rows?: readonly (readonly unknown[])[];
  readonly totalRows?: number;
  readonly returned?: number;
  readonly truncated?: Record<string, boolean>;
  readonly bytesProcessed?: number;
  readonly bytesBilled?: number;
  readonly costUsd?: number;
  readonly cacheHit?: boolean;
  readonly job?: { readonly project: string; readonly jobId: string; readonly location: string };
  readonly next?: string;
  readonly warnings?: readonly { readonly code: string; readonly message: string }[];
  readonly trust: "untrusted";
}

/** One finished or running read, as every query-shaped method answers. Exported for `query` and the sources. */
export function queryResult(prepared: PreparedRead, run: ReadRun): ReadRunAnswer {
  const costFields = { bytesProcessed: run.bytesProcessed, bytesBilled: run.bytesBilled, costUsd: run.usd, cacheHit: run.cacheHit };
  if (run.state === "failed") {
    const billed = run.bytesBilled > 0 ? `, and ${run.bytesBilled} bytes were billed` : "";
    throw new BigQueryError(run.failure!.code, `${run.failure!.detail}${billed}`, run.failure!.next ?? "Check the SQL and run it again.");
  }
  if (run.state === "running") return { state: "running", job: run.job, ...costFields, next: jobNext(run.job), trust: "untrusted" };
  const saved = run.inline === false;
  const more = run.truncated?.rows === true || run.truncated?.bytes === true;
  return {
    state: "done",
    columns: [...(run.columns ?? [])],
    rows: (run.rows ?? []).map((row) => [...row]),
    totalRows: run.totalRows,
    returned: run.returned,
    ...(run.truncated ? { truncated: { ...run.truncated } } : {}),
    ...costFields,
    job: run.job,
    ...(run.warnings.length > 0 ? { warnings: [...run.warnings] } : {}),
    ...(saved || more ? { next: saveNext(run.job) } : {}),
    trust: "untrusted",
  };
}

/** What `save` is told to do with the job whose rows were withheld or cut. */
export function saveNext(job: { readonly project: string; readonly jobId: string; readonly location: string }): string {
  return `save({ project: ${quote(job.project)}, jobId: ${quote(job.jobId)}, location: ${quote(job.location)}, path: "results.jsonl", format: "jsonl" })`;
}

/** Whether two plans differ in a way design §5.2 calls `PLAN_CHANGED`. */
function changed(category: Category, statement: PlannedStatement, prepared: PreparedRead, classification: Classification, freshTargets: readonly Target[]): string | undefined {
  if (classification.category !== category) return `The statement now classifies as ${classification.category}, and the plan was made as ${category}`;
  if (prepared.statementType !== statement.statementType) return `The statement now parses as ${prepared.statementType}, and the plan was made for ${statement.statementType}`;
  if (!sameTargets(freshTargets, statement.targets)) return "The statement's targets changed since the plan was made";
  if (prepared.location !== statement.location) return "The statement's location changed since the plan was made";
  if (classification.capEnforceable !== statement.capEnforceable) return "Whether the byte cap bounds the statement changed since the plan was made";
  if (prepared.bytes > statement.estimateBytes * 1.1) return "The statement's estimate grew more than 10 percent since the plan was made";
  return undefined;
}

/** Long-poll a started job with `getQueryResults`, then read its final state; a DDL job may have no results to page. */
async function awaitJob(context: HandlerContext, started: JobStatus, deadline: number): Promise<JobStatus> {
  let status = started;
  for (let attempt = 0; status.state !== "DONE" && attempt < WAIT_ATTEMPTS; attempt += 1) {
    const remaining = deadline - context.ports.clock.now();
    if (remaining <= 0) break;
    try {
      await context.ports.bigquery.results(context.account, status.ref, { timeoutMs: Math.min(30_000, remaining), maxResults: 1 }, context.signal);
    } catch {
      // A DDL job has no result table; jobs.get below is the authority on what happened.
    }
    status = await context.ports.bigquery.getJob(context.account, status.ref, context.signal);
  }
  return status;
}

/** Record what the job actually billed, by job id, under the cross-process lock (design §6.2 item 4). */
async function record(context: HandlerContext, input: { status: JobStatus; location: string; via: string; session: string }): Promise<void> {
  const billed = input.status.totalBytesBilled ?? 0;
  if (billed <= 0) return;
  try {
    await context.ports.ledger.record({
      at: new Date(input.status.endTime ?? context.ports.clock.now()).toISOString(),
      account: context.account,
      project: input.status.ref.projectId,
      location: input.status.ref.location ?? input.location,
      jobId: input.status.ref.jobId,
      bytesBilled: billed,
      via: input.via,
      session: input.session,
    });
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
  };
}

const jobNext = (job: { readonly project: string; readonly jobId: string; readonly location: string }) =>
  `job({ project: ${quote(job.project)}, jobId: ${quote(job.jobId)}, location: ${quote(job.location)}, wait: 30 })`;

/** A validated identifier for a `next`: a plain name, otherwise `object`. */
const quote = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`");

/** A label value: lowercase letters, digits, underscores and dashes, at most 63. */
const labelOf = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63) || "tool";
