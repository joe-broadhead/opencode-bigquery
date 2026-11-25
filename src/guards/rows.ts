/**
 * The row gate (review H-1): every path that returns rows to a model passes it, so the policy-tag rule (Q6) and the
 * account's inline option (Q11) are decided in one place instead of once per tool.
 *
 * - `query` and `profile` reach it through `runRead`, with the verdict `prepareRead` made from the
 *   tables BigQuery's dry runs named (the query's own and every expanded view and routine body's).
 * - `job` reaches it with the job's referenced objects: the verdict of a query this process prepared when the
 *   job is that query's, and otherwise a fail-closed one — any tagged column in a referenced table, a view or routine,
 *   a script, or a cache hit that names nothing means no inline rows.
 * - `table`'s sample reaches it for the inline option; its tagged columns are withheld by construction.
 *
 * The dataset fence is a separate check, in `assertFenced`, and every path that can return a fenced object's rows calls
 * it before this.
 */
import type { Options } from "../options.js"
import type { Warning } from "./cost.js"
import type { PolicyVerdict } from "./policy.js"
import { type AccountSettings, settingsOf } from "./settings.js"
import type { TableFacts } from "./tables.js"

export interface RowGate {
  readonly inline: boolean
  /** Why rows may not come inline, for the warning's message. Absent when they may. */
  readonly why?: string
  readonly warnings: readonly Warning[]
}

export interface RowGateInput {
  readonly options: Options
  readonly account: string
  readonly settings?: AccountSettings
  readonly tables: readonly TableFacts[]
  readonly policy: PolicyVerdict
}

export function rowGate(input: RowGateInput): RowGate {
  const settings = input.settings ?? settingsOf(input.options, input.account)
  const warnings: Warning[] = []
  const denied = inlineDenied(input.options, input.account, input.tables, settings)
  if (!input.policy.inline) {
    warnings.push({ code: "POLICY_TAGGED_SOURCE", message: `${input.policy.why ?? "A referenced table has a policy-tagged column"}; no rows are inline.` })
  }
  if (denied) {
    warnings.push({ code: "INLINE_DENIED", message: "A referenced dataset is save-only by the account's inline option, so no rows are inline." })
  }
  const why = !input.policy.inline ? (input.policy.why ?? "a referenced table has a policy-tagged column") : denied ? "the account's inline option makes a referenced dataset save-only" : undefined
  return { inline: input.policy.inline && !denied, ...(why !== undefined ? { why } : {}), warnings }
}

/** Whether the account's `inline.deny` makes a referenced dataset save-only (design §7, Q11). */
export function inlineDenied(options: Options, account: string, tables: readonly TableFacts[], settings?: AccountSettings): boolean {
  const deny = (settings ?? settingsOf(options, account)).inlineDeny
  if (deny.length === 0) return false
  return tables.some((facts) => deny.some((pattern) => inlineMatches(pattern, facts.project, facts.dataset)))
}

/** An `inline.deny` pattern, matched on `project.dataset` like the fence. */
export function inlineMatches(pattern: string, project: string, dataset: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(`${project}.${dataset}`)
}
