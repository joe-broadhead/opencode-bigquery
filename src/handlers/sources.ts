/**
 * The source methods (design §10): `events_list`, `saved_read`, `saved_list` (the saved source's bind-time suggest read)
 * and `probe`. A source read answers the contract's page or snapshot; a failure is a contract refusal, which `mapped`
 * builds from the plugin's own codes.
 */
import { EVENTS_LIST_INPUT_SCHEMA, LIST_OPTIONS_SCHEMA, PAGE_SCHEMA, PROBE_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/events";
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register";
import { mapped } from "../refusals.js";
import { eventsPage, probeSource, type SourceDeps, savedList, savedRead } from "../sources/index.js";
import type { HandlerDeps } from "./context.js";
import { PROBE_INPUT, SAVED_LIST_INPUT, SAVED_READ_INPUT, SNAPSHOT_OUTPUT } from "./schemas.js";

const depsOf = (deps: HandlerDeps, call: { account: string; sessionID: string; signal: AbortSignal }): SourceDeps => ({ ports: deps.ports, options: deps.options, account: call.account, sessionID: call.sessionID, signal: call.signal });

export function sourceHandlers(deps: HandlerDeps): Record<"events_list" | "saved_read" | "saved_list" | "probe", MethodHandler> {
  return {
    events_list: {
      description: "The bigquery.jobs source: the jobs this account finished, oldest first, from a cursor.",
      input: EVENTS_LIST_INPUT_SCHEMA,
      output: PAGE_SCHEMA,
      run: mapped(async (input, call) => eventsPage(depsOf(deps, call), input)),
    },
    saved_read: {
      description: "The bigquery.saved source: one saved query's result, as a table.",
      input: SAVED_READ_INPUT,
      output: SNAPSHOT_OUTPUT,
      run: mapped(async (input, call) => savedRead(depsOf(deps, call), String(input["name"]), input["scope"] as Readonly<Record<string, string | readonly string[]>> | undefined)),
    },
    saved_list: {
      description: "The saved queries this source may run, each with its SQL and a free estimate, for a person to confirm.",
      input: SAVED_LIST_INPUT,
      output: LIST_OPTIONS_SCHEMA,
      run: mapped(async (_input, call) => savedList(depsOf(deps, call))),
    },
    probe: {
      description: "The signed-in account behind a source, with no BigQuery content.",
      input: PROBE_INPUT,
      output: PROBE_SCHEMA,
      run: mapped(async (input, call) => probeSource(depsOf(deps, call), input)),
    },
  };
}
