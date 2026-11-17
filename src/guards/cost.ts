/**
 * The cost guards (design §6.2): the cap every job carries, the budget from what Google actually billed, and the
 * estimate in dollars. The cap is `min(maxBytes ?? maxBytesBilled, maxBytesCeiling, what the budget leaves)`; the
 * ceiling is the person's option and never a tool input, so a call cannot raise it.
 *
 * The budget is opt-in, in bytes billed, over a local day and/or this session, and is counted from the ledger's actual
 * `totalBytesBilled` (§6.2 item 4). `refuse` answers `BUDGET_REACHED` before anything runs; `warn` runs and says how
 * much is left. An estimate over the cap answers `COST_CAP` before anything runs, because Google's own check would stop
 * the job at the same number with a different code.
 */
import { BigQueryError } from "../domain/errors.js"
import type { WarningCode } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { Ports } from "../ports.js"

export interface Warning {
  readonly code: WarningCode
  readonly message: string
}

/** The start of the local day `now` falls in: budgets reset at local midnight, as the ledger records local days. */
export function localDayStart(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** On-demand dollars for a number of bytes, at the account's configured price per TiB. */
export function usdFor(bytes: number, options: Options): number {
  return (bytes / 2 ** 40) * options.onDemandUsdPerTiB
}

const UNITS: readonly [number, string][] = [
  [2 ** 40, "TiB"],
  [2 ** 30, "GiB"],
  [2 ** 20, "MiB"],
  [2 ** 10, "KiB"],
]

/** `10 GiB`, `512 MiB`: a number and a unit, never a locale-formatted amount. */
export function formatBytes(bytes: number): string {
  for (const [size, unit] of UNITS) {
    if (Math.abs(bytes) < size) continue
    const value = bytes / size
    return `${Number.isInteger(value) ? value : Number(value.toFixed(2))} ${unit}`
  }
  return `${bytes} B`
}

export interface CapAndBudget {
  readonly capBytes: number
  /** `BUDGET_WARN` when the budget is nearly spent or `warn` lets a spent one through. */
  readonly warnings: readonly Warning[]
  /** What the budget leaves, when one is set; the caller's `COST_CAP` message says so. */
  readonly remainingBytes?: number
}

export interface CapAndBudgetInput {
  readonly options: Options
  readonly ports: Ports
  readonly account: string
  /** The session hash the ledger records. */
  readonly session: string
  readonly now: number
  /** The estimate, for the near-budget warning; 0 when the caller has none. */
  readonly estimateBytes: number
  readonly requested?: number
}

export async function capAndBudget(input: CapAndBudgetInput): Promise<CapAndBudget> {
  if (input.requested !== undefined && input.requested > input.options.maxBytesCeiling) {
    throw new BigQueryError(
      "INPUT_INVALID",
      `maxBytes is ${input.requested} bytes, above the account's maxBytesCeiling of ${input.options.maxBytesCeiling} bytes`,
      "Pass maxBytes at or below the ceiling, or ask the user to raise maxBytesCeiling.",
    )
  }
  const base = Math.min(input.requested ?? input.options.maxBytesBilled, input.options.maxBytesCeiling)
  const budget = input.options.budget
  if (!budget) return { capBytes: base, warnings: [] }

  const [today, session] = await Promise.all([
    budget.daily !== undefined ? input.ports.ledger.spent({ account: input.account, since: localDayStart(input.now) }) : Promise.resolve(0),
    budget.session !== undefined ? input.ports.ledger.spent({ account: input.account, since: 0, session: input.session }) : Promise.resolve(0),
  ])
  const left: number[] = []
  if (budget.daily !== undefined) left.push(budget.daily - today)
  if (budget.session !== undefined) left.push(budget.session - session)
  if (left.length === 0) return { capBytes: base, warnings: [] }
  const remaining = Math.min(...left)
  const spent = `spent ${formatBytes(today)} today and ${formatBytes(session)} this session`

  if (remaining <= 0) {
    if (budget.action === "refuse") {
      throw new BigQueryError(
        "BUDGET_REACHED",
        `The account ${input.account} has ${spent}, and the budget is spent`,
        "Wait for the budget to reset, narrow the query, or ask the user to raise the budget option.",
      )
    }
    return {
      capBytes: base,
      warnings: [{ code: "BUDGET_WARN", message: `The account ${input.account} has ${spent}, and the budget is spent; the call runs because the budget's action is warn.` }],
      remainingBytes: remaining,
    }
  }

  const warnings: Warning[] = []
  const configured = Math.min(...[budget.daily ?? Infinity, budget.session ?? Infinity])
  if (Number.isFinite(configured) && remaining <= configured * 0.1) {
    warnings.push({ code: "BUDGET_WARN", message: `The account ${input.account} has ${spent}: only ${formatBytes(remaining)} of the budget is left.` })
  }
  return { capBytes: Math.min(base, remaining), warnings, remainingBytes: remaining }
}
