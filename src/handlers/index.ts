// The one handler table: every method the manifest declares, with its description, its input and answer schemas and its
// work. `register` wires the agent tool, Code Mode and the RPC door from this table; nothing here touches a door.
import type { HandlerTable, MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register";
import { mapped } from "../refusals.js";
import { changeHandlers } from "./changes.js";
import { type HandlerDeps, withCall } from "./context.js";
import { fileHandlers } from "./files.js";
import { estimate, job, jobs, list, profile, query, search, table } from "./reads.js";
import {
  EMPTY,
  ESTIMATE_INPUT,
  ESTIMATE_OUTPUT,
  JOB_INPUT,
  JOB_OUTPUT,
  JOBS_INPUT,
  JOBS_OUTPUT,
  LIST_INPUT,
  LIST_OUTPUT,
  PROFILE_INPUT,
  PROFILE_OUTPUT,
  QUERY_INPUT,
  QUERY_OUTPUT,
  SEARCH_INPUT,
  SEARCH_OUTPUT,
  TABLE_INPUT,
  TABLE_OUTPUT,
} from "./schemas.js";
import { sourceHandlers } from "./sources.js";
import { createStatus } from "./status.js";

export function createHandlers(deps: HandlerDeps): HandlerTable {
  const reads: Record<"list" | "table" | "search" | "estimate" | "query" | "job" | "jobs" | "profile", MethodHandler> = {
    list: {
      description: "Projects; a project's datasets; a dataset's tables or routines. Free.",
      input: LIST_INPUT,
      output: LIST_OUTPUT,
      run: mapped(async (input, call) => list(input as never, withCall(deps, call))),
    },
    table: {
      description: "A table's schema, partitioning, clustering, size and view SQL; an optional small sample. Free unless partitions.",
      input: TABLE_INPUT,
      output: TABLE_OUTPUT,
      run: mapped(async (input, call) => table(input as never, withCall(deps, call))),
    },
    search: {
      description: "Find tables and columns by name or description. Billed at least 10 MB per view read.",
      input: SEARCH_INPUT,
      output: SEARCH_OUTPUT,
      run: mapped(async (input, call) => search(input as never, withCall(deps, call))),
    },
    estimate: {
      description: "Dry-run SQL: type, referenced objects, bytes, cost, and whether the byte cap bounds it. Free.",
      input: ESTIMATE_INPUT,
      output: ESTIMATE_OUTPUT,
      run: mapped(async (input, call) => estimate(input as never, withCall(deps, call))),
    },
    query: {
      description: "Run SELECT or ASSERT under a byte cap, after a dry run. Billed. A read the cap cannot bound needs plan_query, then run_query.",
      input: QUERY_INPUT,
      output: QUERY_OUTPUT,
      run: mapped(async (input, call) => query(input as never, withCall(deps, call))),
    },
    job: {
      description: "One job's state, bytes and errors, and a page of its results. Free.",
      input: JOB_INPUT,
      output: JOB_OUTPUT,
      run: mapped(async (input, call) => job(input as never, withCall(deps, call))),
    },
    jobs: {
      description: "This account's recent jobs. Free.",
      input: JOBS_INPUT,
      output: JOBS_OUTPUT,
      run: mapped(async (input, call) => jobs(input as never, withCall(deps, call))),
    },
    profile: {
      description: "One aggregate query that profiles a table or a SELECT. Billed, capped.",
      input: PROFILE_INPUT,
      output: PROFILE_OUTPUT,
      run: mapped(async (input, call) => profile(input as never, withCall(deps, call))),
    },
  };

  return {
    status: createStatus(deps),
    ...reads,
    ...sourceHandlers(deps),
    ...changeHandlers(deps),
    ...fileHandlers(deps),
  };
}

export type { HandlerTable };
