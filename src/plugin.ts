// The server part: registers the `bigquery` namespace and its tools, the default permission rules, status, the tools
// RPC for scripts and the skills, in opencode-github's setup order. Everything goes through public OpenCode plugin
// APIs. Every transform is synchronous and never throws: a failure is kept and shown by status.
import { Plugin } from "@opencode/plugin"
import { registerToolsRpc } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { registerAuth } from "./auth/index.js"
import { PLUGIN_ID } from "./constants.js"
import { checkHost } from "./host-version.js"
import { PLUGIN, scriptMethods } from "./host/script-methods.js"
import { loadOptions } from "./options.js"
import { registerPermissionDefaults } from "./permissions.js"
import { registerSkills, SKILL_IDS, skillPath } from "./skills.js"
import { registerStatus } from "./status.js"
import type { HostAssert, ToolSpec } from "./tool-spec.js"
import { registerTools } from "./tools.js"

type Registration = { dispose(): Promise<void> }

/** Internal seam: the specs to register, and which are model tools. The registry supplies them; tests may pass their own. */
export interface BigQuerySeam {
  readonly specs: (options: ReturnType<typeof loadOptions>) => readonly ToolSpec[]
  /** The model's tools among the specs; the rest are tools RPC methods only. */
  readonly isModelTool: (spec: ToolSpec) => boolean
  /** How many specs answer NOT_BUILT, for status. */
  readonly notBuilt: number
}

export function createBigQueryPlugin(seam: BigQuerySeam) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = loadOptions(ctx.options)
      const hostWarning = checkHost(ctx.app.version, options.allowUntestedHost)
      const registrations: Registration[] = []
      const keep = <R extends Registration>(registration: R): R => {
        registrations.push(registration)
        return registration
      }
      const cleanup = async () => {
        for (const registration of registrations.splice(0).reverse()) await registration.dispose()
      }
      // Transforms replay on every rebuild, so each one overwrites its own entry rather than appending.
      const problems = new Map<string, string>()
      const report = (area: string) => (problem: string | undefined) => void (problem ? problems.set(area, problem) : problems.delete(area))
      const assert: HostAssert = (request) => ctx.permission.assert(request as never)
      const specs = seam.specs(options)
      try {
        keep(await registerPermissionDefaults(ctx, options.access, report("rules")))
        const tools = specs.filter(seam.isModelTool)
        keep(await registerTools(ctx, { access: options.access, specs: tools, assert, report: report("tools") }))
        keep(
          await registerStatus(ctx, {
            access: options.access,
            hostVersion: ctx.app.version,
            ...(hostWarning ? { hostWarning } : {}),
            tools: () => ({ registered: tools.length, notBuilt: seam.notBuilt }),
            skills: SKILL_IDS.map((id) => ({ id, path: skillPath(id) })),
            problems: () => [...problems.values()],
          }),
        )
        // Scripts call the reads with no model, as a session and its agent: the read tools and the method-only reads.
        const stopTools = await registerToolsRpc(ctx as never, { plugin: PLUGIN, methods: scriptMethods(specs, assert) })
        keep({ dispose: stopTools })
        keep(await registerSkills(ctx))
        // The same options object seam.specs passed to createPorts: the auth state is keyed on it.
        keep(await registerAuth(ctx, { options, fetch: globalThis.fetch }))
      } catch (error) {
        await cleanup().catch(() => undefined)
        throw error
      }
      return cleanup
    },
  })
}
