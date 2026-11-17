// The `bigquery` namespace and the plugin's tools. The transform describes the namespace for Code Mode and registers
// each tool from its spec. Synchronous; it never throws, and a failure is kept for status.
import type { Plugin } from "@opencode/plugin"
import { type Access, NAMESPACE, NAMESPACE_DESCRIPTION } from "./constants.js"
import { errorText } from "./domain/errors.js"
import { reasonOf } from "./redact.js"
import { buildTool, type HostAssert, type ToolSpec } from "./tool-spec.js"

type ToolContext = { readonly tool: Pick<Plugin.Context["tool"], "transform"> }

export async function registerTools(
  ctx: ToolContext,
  input: {
    readonly access: Access
    readonly specs: readonly ToolSpec[]
    readonly assert: HostAssert
    readonly report: (problem: string | undefined) => void
  },
): Promise<{ dispose(): Promise<void> }> {
  return ctx.tool.transform((editor) => {
    try {
      editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION[input.access] })
      for (const spec of input.specs) editor.add(buildTool(spec, input.assert) as never)
      input.report(undefined)
    } catch (error) {
      input.report(errorText("TOOLS_NOT_REGISTERED", `The ${NAMESPACE} tools could not be registered (${reasonOf(error)})`))
    }
  })
}
