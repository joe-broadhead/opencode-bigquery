/**
 * The row-policy probe's SQL (design §5.1 step 7.2): a free dry run that never reads a policy-tagged column, over a
 * filter that cannot prune to nothing. Package C runs it; Day 0 fixes its text, because a wrong text is not an error but
 * a wrong answer: `SELECT * EXCEPT ()` is a syntax error, which would make every policy-free table "unknown" and send
 * every query over it to a plan (review round 4, LOW 1). With no tagged column the probe is plain `SELECT *`.
 */
import type { TableReference } from "./google.js"

/** A path or column, backquoted with its own backquotes and backslashes escaped. */
const quote = (name: string) => `\`${name.replace(/[\\`]/g, (char) => `\\${char}`)}\``

export const tablePath = (ref: TableReference) => quote(`${ref.projectId}.${ref.datasetId}.${ref.tableId}`)

/** The lowest value of a partitioning column's type, so `>= minimum OR IS NULL` keeps every partition. */
export const TYPE_MINIMUM: Readonly<Record<string, string>> = {
  DATE: "DATE '0001-01-01'",
  TIMESTAMP: "TIMESTAMP '0001-01-01 00:00:00+00'",
  DATETIME: "DATETIME '0001-01-01'",
}

/** How the table is partitioned, as tables.get reports it. */
export type Partitioning =
  | { readonly kind: "column"; readonly column: string; readonly type: "DATE" | "TIMESTAMP" | "DATETIME" }
  | { readonly kind: "range"; readonly column: string; readonly start: string }
  | { readonly kind: "ingestion" }

/** A filter that satisfies `requirePartitionFilter` and keeps every row, the `__NULL__` and `__UNPARTITIONED__` partitions included. */
export function partitionFloor(partitioning: Partitioning): string {
  if (partitioning.kind === "ingestion") return `_PARTITIONTIME >= ${TYPE_MINIMUM.TIMESTAMP} OR _PARTITIONTIME IS NULL`
  const column = quote(partitioning.column)
  const minimum = partitioning.kind === "range" ? partitioning.start.replace(/[^0-9-]/g, "") : TYPE_MINIMUM[partitioning.type]
  return `${column} >= ${minimum} OR ${column} IS NULL`
}

/**
 * The probe: every column but the tagged ones (nested tagged fields are left out by their top-level column). With no
 * tagged column, plain `SELECT *`; with every column tagged, the caller probes tagged columns one at a time instead.
 */
export function probeSelect(ref: TableReference, taggedTopLevel: readonly string[], filter?: string): string {
  const tagged = [...new Set(taggedTopLevel)]
  const columns = tagged.length === 0 ? "*" : `* EXCEPT (${tagged.map(quote).join(", ")})`
  return `SELECT ${columns} FROM ${tablePath(ref)}${filter ? ` WHERE ${filter}` : ""}`
}
