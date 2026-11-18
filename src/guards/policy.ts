/**
 * Policy-tagged values (design §5.3, Q6): withheld exactly in samples, and never inline from a query that might read
 * them.
 *
 * The rule is stated over the **tables BigQuery names**, not over the query's text. The dry run's
 * `referencedTables`, and the same list from a dry run of every view and SQL routine body expansion reaches, are
 * Google's parse of what runs, so no alias, comma join, `USING`, `UNNEST`, quoting or nesting can hide a table from it
 * (review bigquery-3 R-1). What the server does not say is which **columns** a query reads: Google's Job resource has no
 * column-level list, and a result schema carries no tags. So the plugin cannot prove from the server's answer that a
 * query reads no tagged column, and the rule is conservative:
 *
 * - when any table in that set (a base table reached through a view or a routine included) has a policy-tagged column,
 *   the answer has no inline rows, warns `POLICY_TAGGED_SOURCE`, and points at `bigquery_save` (the file stays local);
 * - otherwise rows come inline;
 * - the person's `policyTagged: "allow"` option turns the rule off. No tool input can.
 *
 * A query naming only untagged columns of a tagged table is therefore save-only too. `bigquery_table`'s sample
 * withholds the tagged columns exactly, and `bigquery_profile` over a table builds its own SQL from the schema, so both
 * can still show the untagged columns inline.
 *
 * A name in a message is a validated identifier (`path`), never the name the data chose.
 */
import { path } from "../domain/identifiers.js"
import type { TableFacts } from "./tables.js"

export interface PolicyVerdict {
  readonly inline: boolean
  /** Why rows may not come inline, for the warning's message. Absent when they may. */
  readonly why?: string
}

export interface PolicyInput {
  /** Every table and view in the server set: the dry run's own references and everything expansion reached. */
  readonly tables: readonly TableFacts[]
  readonly mode: "withhold" | "allow"
}

export function policyVerdict(input: PolicyInput): PolicyVerdict {
  if (input.mode === "allow") return { inline: true }
  const tagged = input.tables.find((facts) => facts.tagged.length > 0)
  if (tagged === undefined) return { inline: true }
  const table = path(tagged.project, tagged.dataset, tagged.table)
  return {
    inline: false,
    why: `the query reads the table ${table}, which has a policy-tagged column, and BigQuery's dry run names the tables a query reads but not its columns`,
  }
}
