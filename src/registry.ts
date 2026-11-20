/**
 * The registry: every entry of the action table (src/domain/actions.ts) as a spec, with its schemas from the contract
 * (src/domain/contract.ts) and its handler from the package that builds it. A handler not built yet answers `NOT_BUILT`.
 *
 * What the registry guarantees for every handler, so no package has to:
 * - the account is resolved (`ACCOUNT_UNKNOWN`, `ACCOUNT_REQUIRED`) before anything else;
 * - a read asserts its own action on `<account>:<operation>` before the handler runs; a change asserts it in its
 *   handler, with the plan's preview as metadata, so the person is asked once (D builds that);
 * - the ports the handler gets refuse any request before the tool's own action was asserted, so no tool can reach
 *   Google first, and `call.assert` refuses an action the table does not declare (asserted = declared);
 * - `bigquery_query({ planId })` from a script is refused: an uncapped-read plan (`bigquery.uncapped_read`) runs only
 *   from a session's tool, where the user can see its preview and be asked, never from a script (`PERMISSION_DENIED`);
 * - a `BigQueryError` becomes the result envelope on the model path, and the tools RPC's failure on a script's path.
 */
import type * as z from "zod"
import { type ActionEntry, ACTIONS, ASKS, ASSERTABLE, RPC_METHODS } from "./domain/actions.js"
import { operationResource, resolveAccount } from "./domain/accounts.js"
import { type InputOf, type OutputOf, SCHEMAS, type ToolName } from "./domain/contract.js"
import { BigQueryError } from "./domain/errors.js"
import { CHANGE_HANDLERS } from "./handlers/changes.js"
import { FILE_HANDLERS } from "./handlers/files.js"
import { READ_HANDLERS } from "./handlers/reads.js"
import { SOURCE_HANDLERS } from "./handlers/sources.js"
import { STATUS_HANDLERS } from "./handlers/status.js"
import { accountsOf, type Options } from "./options.js"
import type { Ports } from "./ports.js"
import { NOT_RELEASED_DETAIL, NOT_RELEASED_NEXT } from "./release.js"
import type { AssertRequest, Call, Outcome, ToolSpec } from "./tool-spec.js"

/** OpenCode's own actions a tool may assert besides the table's: `bigquery_save` writes a local file. */
export const ENGINE_ACTIONS: ReadonlySet<string> = new Set(["edit", "external_directory"])

/** What a handler gets besides its input. */
export interface HandlerContext {
  /** The resolved account alias. */
  readonly account: string
  /** The call, with an assert that refuses undeclared actions. */
  readonly call: Call
  /** The ports, guarded: none answers before the tool's own action was asserted. */
  readonly ports: Ports
  readonly options: Options
}

export type Handler<N extends ToolName> = (input: InputOf<N>, context: HandlerContext) => Promise<OutputOf<N>>
export type Handlers = { readonly [N in ToolName]?: Handler<N> }

/** Every package's handlers. Each name is built by exactly one package; a test checks no two files define one. */
export const HANDLERS: Handlers = { ...STATUS_HANDLERS, ...READ_HANDLERS, ...CHANGE_HANDLERS, ...FILE_HANDLERS, ...SOURCE_HANDLERS }

/** The tools RPC's methods, by name: the read tools and the two method-only reads. */
export const RPC_METHOD_NAMES: readonly string[] = RPC_METHODS.map((entry) => entry.name)

/** The operation a call's first assert names. */
export function operationOf(entry: ActionEntry, input: Record<string, unknown>): string {
  if (entry.operation !== "input") return entry.operation
  // bigquery_table: the table's metadata, a sample (a data read too), or its partitions (an INFORMATION_SCHEMA query).
  if (entry.name === "table") return input.partitions === true ? "bigquery.jobs.query" : input.sample ? "bigquery.tabledata.list" : "bigquery.tables.get"
  // bigquery_list: projects, a project's datasets, or a dataset's tables or routines.
  if (input.project === undefined) return "bigquery.projects.list"
  if (input.dataset === undefined) return "bigquery.datasets.list"
  return input.kind === "routines" ? "bigquery.routines.list" : "bigquery.tables.list"
}

/** A refusal or failure as the result envelope (design §4). `message` and `next` come from the error, never Google. */
export function refusal(error: BigQueryError): Record<string, unknown> {
  const { reason, retryAfterSec, googleError } = error.extras
  return {
    state: error.state === "setup" ? "refused" : error.state,
    error: error.code,
    message: error.detail,
    next: error.next,
    ...(reason !== undefined ? { reason } : {}),
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    ...(googleError !== undefined ? { googleError } : {}),
  }
}

/** The ports, refusing every request until `asserted()` is true. A request before the tool's own assert is a bug. */
export function guardPorts(ports: Ports, tool: string, asserted: () => boolean): Ports {
  const guard = <T extends object>(target: T, name: string): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver)
        if (typeof value !== "function" || key === "accounts") return value
        return (...args: unknown[]) => {
          if (!asserted()) throw new Error(`${tool} called ${name}.${String(key)} before asserting its own action`)
          return value.apply(object, args)
        }
      },
    })
  return { ...ports, bigquery: guard(ports.bigquery, "bigquery"), auth: guard(ports.auth, "auth") }
}

/** Builds the specs for these options and ports, with these handlers (tests pass their own). */
export function toolSpecs(options: Options, ports: Ports, handlers: Handlers = HANDLERS): readonly ToolSpec[] {
  const aliases = Object.keys(accountsOf(options))
  return ACTIONS.filter((entry) => entry.kind === "tool" || entry.kind === "method").map((entry) => specOf(entry, options, ports, aliases, handlers))
}

/** The model's tools: the nineteen `kind: "tool"` entries. Method-only entries are tools RPC methods only. */
export const isModelTool = (spec: ToolSpec) => ACTIONS.find((entry) => entry.action === spec.action)?.kind === "tool"

function specOf(entry: ActionEntry, options: Options, ports: Ports, aliases: readonly string[], handlers: Handlers): ToolSpec {
  const schemas = SCHEMAS[entry.name as ToolName]
  const handler = handlers[entry.name as ToolName] as ((input: unknown, context: HandlerContext) => Promise<unknown>) | undefined
  const local = entry.operation === "local"
  return {
    name: entry.name,
    action: entry.action,
    readOnly: entry.readOnly,
    class: entry.class,
    description: schemas.description,
    input: schemas.input as z.ZodType,
    output: schemas.output as z.ZodType,
    ...(entry.readOnly && !local
      ? {
          resource: (input: unknown) => {
            const record = (input ?? {}) as Record<string, unknown>
            const named = typeof record.account === "string" ? record.account : undefined
            const account = resolveAccount(aliases, named)
            return operationResource(account, operationOf(entry, record))
          },
          ...(entry.resourceKind ? { resourceKind: entry.resourceKind } : {}),
        }
      : {}),
    async run(input: unknown, call: Call): Promise<Outcome<unknown>> {
      try {
        // A source install must not reach Google. Handlers stay; a tagged install, or a test that simulates one, runs them.
        if (ports.released !== undefined && !(await ports.released()) && entry.operation !== "local") {
          throw new BigQueryError("NOT_RELEASED", NOT_RELEASED_DETAIL, NOT_RELEASED_NEXT)
        }
        const record = (input ?? {}) as Record<string, unknown>
        const named = typeof record.account === "string" ? record.account : undefined
        const account = local && named === undefined ? (aliases.length === 1 ? aliases[0]! : "*") : resolveAccount(aliases, named)
        if (entry.name === "query" && call.via === "rpc" && record.planId !== undefined) {
          throw new BigQueryError(
            "PERMISSION_DENIED",
            `An uncapped-read plan (${ASKS.uncappedRead}) runs only from a session's tool, where the user sees its preview, never from a script`,
            "Run the plan from a session with bigquery_query({ planId }), or change the query so the byte cap bounds it.",
          )
        }
        let asserted = false
        const guardedCall: Call = {
          ...call,
          assert: async (request: AssertRequest) => {
            if (!ASSERTABLE.has(request.action) && !ENGINE_ACTIONS.has(request.action)) {
              throw new Error(`${entry.action} asserted ${request.action}, which the action table does not declare`)
            }
            await call.assert(request)
            if (request.action === entry.action) asserted = true
          },
        }
        if (entry.readOnly) {
          const resource = local ? "*" : operationResource(account, operationOf(entry, record))
          await guardedCall.assert({ action: entry.action, resources: [resource], save: [resource], metadata: { account, tool: `bigquery_${entry.name}` } })
        }
        if (!handler) throw new BigQueryError("NOT_BUILT", `bigquery_${entry.name} is declared but not built yet`)
        const context: HandlerContext = { account, call: guardedCall, ports: guardPorts(ports, entry.action, () => asserted), options }
        return { output: await handler(input, context) }
      } catch (error) {
        if (!(error instanceof BigQueryError) || call.via === "rpc") throw error
        return { output: refusal(error), metadata: { code: error.code, next: error.next } }
      }
    },
  }
}
