/**
 * `save` (design §7): stream a **finished** query job's result table into a local CSV, JSONL or Parquet file. Its class
 * is export: under `ask-changes` the whole save asks before it runs, and the access level is final.
 *
 * The fence is checked over the objects `jobs.get` names, exactly as `job` does before it shows a row: a job over a
 * fenced dataset is not saved to a file, and a cache hit that names nothing cannot be checked, so it is refused under a
 * fence. Google's free calls only: `jobs.get` and `getQueryResults` paging. A result table expires 24 hours after the
 * original run, and a missing one is `RESULTS_EXPIRED`.
 */

import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register";
import { BigQueryError } from "../domain/errors.js";
import { convertRows, FileWriter, resolveTarget, SAVE_PAGE_ROWS } from "../files/index.js";
import { assertFenced, type FenceObject } from "../guards/fence.js";
import { failureFor } from "../guards/jobfail.js";
import { locationOf, projectOf, settingsOf } from "../guards/settings.js";
import type { JobStatus, ResultPage } from "../ports.js";
import { mapped } from "../refusals.js";
import { emitChanged, type HandlerContext, type HandlerDeps, withCall } from "./context.js";
import { SAVE_INPUT, SAVE_OUTPUT } from "./schemas.js";

const expired = () => new BigQueryError("RESULTS_EXPIRED", "The job's result table is gone", "Run the query again; a result table expires 24 hours after the original run.");

/** The objects a job names, as the fence sees them. */
function jobObjects(status: JobStatus): FenceObject[] {
  const out: FenceObject[] = [];
  for (const ref of status.referencedTables ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "table" });
  for (const ref of status.referencedLogicalViews ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "view" });
  for (const ref of status.referencedRoutines ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.routineId, kind: "routine" });
  return out;
}

async function save(input: Record<string, unknown>, context: HandlerContext): Promise<Record<string, unknown>> {
  const account = context.account;
  const settings = settingsOf(context.options, account);
  const project = projectOf(settings, input["project"] as string | undefined);
  const location = locationOf(settings, input["location"] as string | undefined);

  // The path comes before any Google call: a refused path costs nothing.
  const target = resolveTarget({ path: String(input["path"]), ...(input["overwrite"] === true ? { overwrite: true } : {}) }, context.options);

  const ref = { projectId: project, jobId: String(input["jobId"]), ...(location !== undefined ? { location } : {}) };
  let status: JobStatus;
  try {
    status = await context.ports.bigquery.getJob(account, ref, context.signal);
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") throw expired();
    throw error;
  }
  if (status.state !== "DONE") {
    throw new BigQueryError("INPUT_INVALID", "The job is still running, so its result table is not final", "Wait for it with job({ wait: 30 }), then save it.");
  }
  const failure = failureFor(status);
  if (failure) throw failure;

  const objects = jobObjects(status);
  const blind = status.cacheHit === true && objects.length === 0;
  if (blind && (settings.fence?.allow !== undefined || settings.fence?.deny !== undefined)) {
    throw new BigQueryError(
      "DATASET_FENCED",
      "The job's result came from the query cache, so BigQuery names none of the objects it read and the account's dataset fence cannot be checked",
      "Run the query with query, which checks it before it runs.",
    );
  }
  assertFenced(settings.fence, objects);

  let page: ResultPage;
  try {
    page = await context.ports.bigquery.results(account, status.ref, { timeoutMs: 0, maxResults: SAVE_PAGE_ROWS }, context.signal);
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") throw expired();
    throw error;
  }
  const schema = page.schema ?? [];
  const writer = new FileWriter(target.path, input["format"] as "csv" | "jsonl" | "parquet", schema, { maxRows: context.options.maxSaveRows, maxBytes: context.options.maxSaveBytes });
  try {
    writer.write(convertRows(schema, page.rows));
    while (page.pageToken !== undefined) {
      page = await context.ports.bigquery.results(account, status.ref, { timeoutMs: 0, maxResults: SAVE_PAGE_ROWS, pageToken: page.pageToken }, context.signal);
      writer.write(convertRows(schema, page.rows));
    }
    const written = writer.finish();
    return { path: target.path, rows: written.rows, bytes: written.bytes, sha256: written.sha256, trust: "untrusted" };
  } catch (error) {
    writer.abort();
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") throw expired();
    throw error;
  }
}

export function fileHandlers(deps: HandlerDeps): Record<"save", MethodHandler> {
  return {
    save: {
      description: "Write a finished query's results to a local CSV, JSONL or Parquet file; never calls BigQuery's billed API.",
      input: SAVE_INPUT,
      output: SAVE_OUTPUT,
      run: mapped(async (input, call) => save(input, withCall(deps, call))),
    },
  };
}
