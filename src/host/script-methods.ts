/**
 * BigQuery's part of the tools RPC (`google-cloud.bigquery.tools`): the plugin value and the method table that the
 * source contract's `tools-rpc` module takes. The module (`@we-the-rebel-alliance/source-contract/tools-rpc`,
 * tag v0.2.0, bundled into `dist/index.js`) is the transport every plugin of the family shares:
 *
 *   POST /api/rpc/google-cloud.bigquery.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * A script runs as a session and the agent it names; the rule for the method's permission action is resolved before
 * dispatch, and only `allow` runs. BigQuery has no MCP server, so every method is a plugin-owned read: the read tools'
 * specs. A change is never a method: it runs only from the model's tool, after its own asks.
 */
import type { Failure, MethodSpec, NextSteps, ToolsRpcPlugin } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { toolsRpcId } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID } from "../constants.js"
import { BigQueryError } from "../domain/errors.js"
import { STATUS_COMMAND } from "../rpc.js"
import { type HostAssert, scriptMethod, type ToolSpec } from "../tool-spec.js"

/** The RPC's id: the plugin's id and `.tools`. Scripts and the `sources` block call it by name, so it never changes. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/** Every read spec, as a method. */
export function scriptMethods(specs: readonly ToolSpec[], assert: HostAssert): MethodSpec[] {
  return specs.filter((spec) => spec.class === "read" && spec.readOnly).map((spec) => scriptMethod(spec, assert))
}

/** The next step for each code. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the method's action to the session's agent or to the session, or use a session whose agent allows it.",
  CANCELLED: "Call the method again if you still need the result.",
  RESOURCE_UNRESOLVED: `Name the account in the input when more than one is configured; /${STATUS_COMMAND} lists them.`,
}

/** The plugin's own errors, thrown by a method's spec, as a code, what happened and the next step. */
export function pluginError(error: unknown): Failure | undefined {
  return error instanceof BigQueryError ? { code: error.code, what: error.detail.replace(/\.$/, ""), next: error.next } : undefined
}

export const PLUGIN: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, pluginError }
