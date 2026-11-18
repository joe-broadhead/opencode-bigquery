/**
 * What the person approving a commit reads (review bigquery-8 M-1). Day 0's `planMetadata` cuts the SQL at 2,000
 * characters, which hides a longer statement's tail from the only person who can approve it. This module keeps the
 * allowlisted plan metadata and adds, within it:
 *
 * - the **full SQL** when it is at most 20,000 characters;
 * - past that, the first 20,000 characters, the exact number not shown, and the path of a 0600 file holding the whole
 *   statement, so the person can open what they cannot see in the prompt;
 * - for a script, every statement with its type, its targets and its first line, so the approval is of the statements,
 *   not of one opaque string;
 * - the plan's `committable`, because the order the registry imposes (assert, then the level) means a Read account is
 *   asked before it hears `ACCOUNT_READ_ONLY` (review LOW 1).
 *
 * Parameter values never enter this metadata: `planMetadata` already keeps them out, and only the SQL text is added.
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BigQueryError } from "../domain/errors.js"
import { type Plan, planMetadata } from "../domain/plans.js"
import { stateDir } from "../wiring.js"
import type { ScriptStatementInput } from "./scripts.js"

/** The longest SQL shown whole in a permission prompt, in characters; a longer one is cut and saved to a file. */
export const PROMPT_SQL_FULL = 20_000

/** A plan's script statements, kept on the plan object beside Day 0's fields until the contract carries them. */
export interface PlanScript {
  readonly statements: readonly ScriptStatementInput[]
}

/** A plan's script statements, when it is a script made by this process. */
export function scriptOf(plan: Plan): PlanScript | undefined {
  return (plan as Plan & { readonly script?: PlanScript }).script
}

/**
 * The plan's allowlisted prompt metadata plus the full SQL (or its exact cut and file) and a script's statements. A
 * statement too long to show that cannot be saved is refused, because the person cannot approve what they cannot read.
 */
export function approvalMetadata(plan: Plan): Record<string, unknown> {
  const base = planMetadata(plan)
  const sql = plan.statement.sql
  const shown = sql.length <= PROMPT_SQL_FULL
  const more = sql.length - PROMPT_SQL_FULL
  const file = shown ? undefined : savePlanText(plan)
  const script = scriptOf(plan)
  return {
    ...base,
    sql: shown ? sql : `${sql.slice(0, PROMPT_SQL_FULL)}\n…[+${more} characters not shown; the full statement is in ${
      file ?? "a file that could not be written"
    }]`,
    sqlCharacters: sql.length,
    committable: plan.committable,
    ...(shown ? {} : { sqlMore: more, ...(file !== undefined ? { sqlFile: file } : {}) }),
    ...(script !== undefined
      ? {
          script: {
            count: script.statements.length,
            statements: script.statements.map((statement) => ({
              type: statement.type,
              targets: statement.targets.map((target) => target.label),
              firstLine: statement.firstLine,
            })),
          },
        }
      : {}),
  }
}

/** Remove a statement file once its approval is over (review bigquery-8 LOW 2); an absent file is fine. */
export function removePlanText(planId: string): void {
  try {
    unlinkSync(join(stateDir(), "plans", `${planId}.sql`))
  } catch {
    // The file was never written (a short statement), or the state folder is unavailable; nothing to remove.
  }
}

/** The whole statement in the plugin's state folder, 0600, so the prompt's cut can be read in full. */
function savePlanText(plan: Plan): string {
  try {
    const directory = join(stateDir(), "plans")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `${plan.id}.sql`)
    writeFileSync(file, plan.statement.sql, { mode: 0o600 })
    return file
  } catch {
    throw new BigQueryError(
      "INPUT_INVALID",
      `The statement is ${plan.statement.sql.length} characters, and its full text could not be saved for the approval prompt`,
      "Split the statement into shorter ones, or make the change in the Google Cloud console.",
    )
  }
}
