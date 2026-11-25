/**
 * The change methods (design §5.2): the six planners, the five commits and `run_query`, plus `cancel`.
 *
 * A planner is a read: it dry-runs the statement and answers the preview and the statement the commit will re-check;
 * the register mints the plan id and keeps the answer. A commit is classed by what it does: the register requires the
 * plan, the plan's account and the write level; this handler re-checks the statement and runs it. After a job starts,
 * `changed` tells every app the jobs source moved.
 */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register";
import { commitChange, runPlannedRead } from "../changes/commit.js";
import { type PlanInput, planChange, planQuery } from "../changes/plan.js";
import { type Category, COMMITTER } from "../constants.js";
import { BigQueryError } from "../domain/errors.js";
import type { PlannedChange, PlannedRead } from "../domain/plans.js";
import { failureFor } from "../guards/jobfail.js";
import { locationOf, projectOf, settingsOf } from "../guards/settings.js";
import { mapped } from "../refusals.js";
import { emitChanged, type HandlerDeps, withCall } from "./context.js";
import { CANCEL_INPUT, CANCEL_OUTPUT, COMMIT_OUTPUT, PLAN_INPUT, PLAN_OUTPUT, QUERY_OUTPUT } from "./schemas.js";

/** A validated identifier for a `next`: a plain name, otherwise `object`. */
const plain = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`");

/** The label every job this plugin starts carries (design §6.2 item 7). */
const PLUGIN_LABEL = "bigquery-plugin";
/** The `oc_tool` labels of the plugin's read jobs: a Read account may cancel only these. */
const READ_JOB_TOOLS = new Set(["query", "profile", "table", "search", "saved_read", "run_query"]);

/** A label value for a message: only the plugin's own lowercase labels, otherwise a generic name. */
const toolLabel = (value: string | undefined) => (value !== undefined && /^[a-z0-9_-]{1,63}$/.test(value) ? value : "a job this plugin started");

const PLANNERS: Readonly<Record<Category, string>> = {
  write: "Plan a change that writes data or schema: DML, DDL, and anything that changes an object.",
  export: "Plan an export: a statement that copies data out of BigQuery, such as EXPORT DATA, or a table copy that leaves the account's own dataset.",
  share: "Plan a sharing change: GRANT or REVOKE, row access policies, or an authorized view.",
  delete: "Plan a delete: DROP, DELETE, TRUNCATE, a replace, or a script that does one.",
  admin: "Plan an admin statement: reservations, capacity commitments, assignments, connections, or IAM at project or organisation level.",
};

export function changeHandlers(deps: HandlerDeps): Record<string, MethodHandler> {
  const handlers: Record<string, MethodHandler> = {};

  for (const category of ["write", "export", "share", "delete", "admin"] as const) {
    handlers[`plan_${category}`] = {
      description: `${PLANNERS[category]} Changes nothing: answers a preview and a planId, spent once by ${COMMITTER[category]}.`,
      input: PLAN_INPUT,
      output: PLAN_OUTPUT,
      run: mapped(async (input, call) => planChange(category, input as unknown as PlanInput, withCall(deps, call))),
    };
    handlers[COMMITTER[category]] = {
      description: `Commit a ${category} plan by its planId. It runs the exact statement the preview showed, bounded by that plan's cap.`,
      input: { type: "object", properties: {}, additionalProperties: false },
      output: COMMIT_OUTPUT,
      run: mapped(async (_input, call) => {
        const plan = planOf(call.plan);
        const answer = await commitChange(category, plan, withCall(deps, call));
        await emitChanged(call, "bigquery.jobs", "write");
        return answer;
      }),
    };
  }

  handlers["plan_query"] = {
    description: "Plan a read the byte cap cannot bound, such as one over a remote function or a row-secured table: answers a preview and a planId, spent once by run_query.",
    input: PLAN_INPUT,
    output: PLAN_OUTPUT,
    run: mapped(async (input, call) => planQuery(input as unknown as PlanInput, withCall(deps, call))),
  };
  handlers["run_query"] = {
    description: "Run an uncapped-read plan by its planId, with the plan's cap and the short time limit.",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: QUERY_OUTPUT,
    run: mapped(async (_input, call) => {
      const plan = readPlanOf(call.plan);
      const answer = await runPlannedRead(plan, withCall(deps, call));
      await emitChanged(call, "bigquery.jobs", "read");
      return answer;
    }),
  };

  handlers["cancel"] = {
    description: "Cancel a running job this plugin started; a Read account cancels only the plugin's read jobs.",
    input: CANCEL_INPUT,
    output: CANCEL_OUTPUT,
    run: mapped(async (input, call) => {
      const context = withCall(deps, call);
      const settings = settingsOf(deps.options, call.account);
      const project = projectOf(settings, input["project"] as string | undefined);
      const location = locationOf(settings, input["location"] as string | undefined);
      const ref = { projectId: project, jobId: String(input["jobId"]), ...(location !== undefined ? { location } : {}) };

      // Only a job this plugin started: the plugin's own `oc_` job id and its server-side label. A Read account may cancel
      // only the plugin's read jobs; anything else is someone's scheduled query or ETL (review bigquery-8 H-2).
      const level = await context.ports.auth.level(context.account, context.signal);
      const found = await context.ports.bigquery.getJob(context.account, ref, context.signal);
      const labels = found.labels ?? {};
      if (labels.oc_plugin !== PLUGIN_LABEL || !found.ref.jobId.startsWith("oc_")) {
        throw new BigQueryError(
          "PERMISSION_DENIED",
          `The job ${plain(found.ref.jobId)} was not started by this plugin`,
          "jobs lists the jobs this account started; cancel only a job with the plugin's label, or use the Google Cloud console.",
        );
      }
      if (level.level !== "write" && !READ_JOB_TOOLS.has(labels.oc_tool ?? "")) {
        throw new BigQueryError(
          "PERMISSION_DENIED",
          `The account ${context.account} has the Read level, so it cancels only this plugin's read jobs; this is ${toolLabel(labels.oc_tool)}`,
          "Cancel a write job with a Read and write account, or use the Google Cloud console.",
        );
      }
      const shown = { project: found.ref.projectId, jobId: found.ref.jobId, location: found.ref.location ?? location ?? "" };
      const finished = failureFor(found);
      if (finished !== undefined && finished.code !== "CANCELLED") throw finished;
      if (finished !== undefined || found.state === "DONE") return { job: shown, jobState: found.state, trust: "untrusted" };

      const status = await context.ports.bigquery.cancel(context.account, ref, context.signal);
      const job = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? location ?? "" };
      const completed = failureFor(status);
      if (completed !== undefined && completed.code !== "CANCELLED") throw completed;
      await emitChanged(call, "bigquery.jobs", "cancel");
      return { job, jobState: status.state, trust: "untrusted" };
    }),
  };

  return handlers;
}

/** The change a commit's call carries. A commit only ever runs with the plan its planner answered. */
function planOf(plan: unknown): PlannedChange {
  const held = plan as { change?: PlannedChange } | undefined;
  if (held?.change === undefined) throw new BigQueryError("PLAN_INVALID", "The plan carries no change to commit", "Plan the change again with its planner, then commit with the planId it answers.");
  return held.change;
}

/** The read a `run_query` call carries. */
function readPlanOf(plan: unknown): PlannedRead {
  const held = plan as { query?: PlannedRead } | undefined;
  if (held?.query === undefined) throw new BigQueryError("PLAN_INVALID", "The plan carries no read to run", "Plan the read again with plan_query, then run the planId it answers.");
  return held.query;
}
