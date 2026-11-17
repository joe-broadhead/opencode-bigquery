/**
 * Policy-tagged values (design §5.3, Q6): withheld exactly in samples, and never inline from a query that might read
 * them. A query result's schema carries no policy tags and an alias or an expression defeats any mapping, so the rule
 * is stated over the text: when any referenced table — or any base table of an expanded view — has a tagged column,
 * rows come back inline **only** when the top-level text and every expanded body name none of the tagged columns, use
 * no `*` or `t.*`, and use no table alias as a value (`SELECT t`, `TO_JSON(t)`, `ARRAY_AGG(t)`,
 * `(SELECT AS STRUCT t.*)`). Names compare case-insensitively and backquoted (`` t.`SSN` `` matches a tag on `ssn`).
 * Otherwise the answer has no inline rows, warns `POLICY_TAGGED_SOURCE`, and points at `bigquery_save`.
 *
 * A column named in a message is the validated identifier `column()` returns, never the name the data chose.
 */
import { column, path } from "../domain/identifiers.js"
import type { Findings } from "../domain/lexer-api.js"
import type { TableFacts } from "./tables.js"

export interface PolicyVerdict {
  readonly inline: boolean
  /** Why rows may not come inline, for the warning's message. Absent when they may. */
  readonly why?: string
}

export interface PolicyInput {
  readonly tables: readonly TableFacts[]
  readonly findings: readonly Findings[]
  readonly mode: "withhold" | "allow"
}

export function policyVerdict(input: PolicyInput): PolicyVerdict {
  if (input.mode === "allow") return { inline: true }
  const taggedTables = input.tables.filter((facts) => facts.tagged.length > 0)
  if (taggedTables.length === 0) return { inline: true }
  const first = taggedTables[0]!

  for (const facts of taggedTables) {
    const table = path(facts.project, facts.dataset, facts.table)
    for (const name of facts.tagged) {
      const position = facts.columns.findIndex((field) => field.name === name) + 1
      const shown = column(name, position || 1)
      const upper = name.toUpperCase()
      for (const report of input.findings) {
        if (!report.columnNames.has(upper)) continue
        return { inline: false, why: `the query's own text names the policy-tagged column ${shown} of the table ${table}` }
      }
    }
  }

  for (const report of input.findings) {
    if (report.usesStar) {
      const table = path(first.project, first.dataset, first.table)
      return { inline: false, why: `the query uses * over the table ${table}, which has a policy-tagged column` }
    }
  }

  for (const report of input.findings) {
    if (report.aliasAsValue) {
      const table = path(first.project, first.dataset, first.table)
      return { inline: false, why: `the query uses a table alias as a value, which returns every column of the table ${table}, which has a policy-tagged column` }
    }
  }

  return { inline: true }
}
