/**
 * The hints in design §6.3, one line each, built from validated identifiers only: a partitioned table and the column to
 * filter on, a clustered table and its cluster columns, a `LIMIT` over a full scan, `SELECT *`, and a call that turned
 * the cache off. A hint never changes what runs; it explains a cost the estimate already showed.
 */
import { column, path } from "../domain/identifiers.js"
import type { Findings } from "../domain/lexer-api.js"
import type { TableFacts } from "./tables.js"

export interface HintInput {
  readonly findings: Findings
  readonly tables: readonly TableFacts[]
  readonly bytes: number
  /** Whether the text has a `LIMIT`, from the lexer's tokens. */
  readonly hasLimit: boolean
  readonly useCache: boolean
}

export function hintsFor(input: HintInput): string[] {
  const hints: string[] = []
  const stored = input.tables.filter((facts) => facts.kind === "data")
  const total = stored.reduce((sum, facts) => sum + facts.numBytes, 0)

  if (total > 0 && input.bytes >= total * 0.9) {
    for (const facts of stored) {
      const name = path(facts.project, facts.dataset, facts.table)
      if (facts.partitioning) {
        const partition = facts.partitioning
        const field = partition.kind === "ingestion" ? undefined : facts.columns.find((item) => item.name === partition.column)
        const position = facts.columns.findIndex((item) => item.name === (partition.kind === "ingestion" ? "" : partition.column)) + 1
        const shown = partition.kind === "ingestion" ? "`_PARTITIONTIME`" : column(partition.column, position || (field ? facts.columns.indexOf(field) + 1 : 1))
        hints.push(`The table ${name} is partitioned on ${shown}: filter on it to scan less than this query's estimate.`)
      }
    }
    for (const facts of stored) {
      const clustered = facts.info.clustering?.fields ?? []
      if (clustered.length === 0) continue
      const name = path(facts.project, facts.dataset, facts.table)
      const names = clustered.map((field) => {
        const position = facts.columns.findIndex((item) => item.name === field) + 1
        return column(field, position || 1)
      })
      hints.push(`The table ${name} is clustered on ${names.join(", ")}: filter on them to scan less.`)
    }
  }

  if (input.hasLimit && total > 0 && input.bytes >= total * 0.9) {
    hints.push("A LIMIT does not reduce the bytes this query scans: it stops the rows returned, not the columns read.")
  }
  if (input.findings.usesStar) {
    hints.push("SELECT * reads every column: name the columns the answer needs to scan less.")
  }
  if (!input.useCache) {
    hints.push("The cache is off for this call, so it is billed in full; the same query with the cache on is free to repeat.")
  }
  return hints
}
