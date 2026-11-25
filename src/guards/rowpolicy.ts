/**
 * The row-access check of design §5.1 step 7: is there a row access policy on this table, whatever the caller's own
 * filter sees? Any answer other than "none" makes the byte cap unenforceable, so this fails closed: a probe error the
 * plugin cannot classify is `unknown`, and the query goes to a plan.
 *
 * Three signals, in the design's order:
 * 1. `rowAccessPolicies.list` where the caller may read it (BigQuery Admin, Data Owner): definitive, free.
 * 2. A free dry-run probe that never reads a policy-tagged column — `SELECT * EXCEPT (<tagged>)`, plain `SELECT *` when
 *    none is tagged (never `SELECT * EXCEPT ()`, review round 4 LOW 1) — plus the partitioned filter that cannot prune
 *    to nothing (`src/domain/probe.ts`). Google's dry run estimates 0 bytes for a row-secured table and more for any
 *    other over a non-empty table. With every column tagged, the tagged columns are probed one at a time, widest first.
 *    A column-level denial is never "row-secured": that column is dropped and the probe runs again.
 * 3. The `tabledata.list` `maxResults: 0` probe with one untagged column, which a row-secured table refuses when the
 *    caller has no `TRUE` filter access.
 *
 * A policy listed, a 0-byte estimate over a table with `numBytes` > 0, a refused probe or a refused `tabledata.list` is
 * row-secured. Any other error, or no column the probe may read, is unknown. The 10-minute cache holds either answer,
 * so a policy added later is caught at the next check (§5.1 step 7).
 */
import { BigQueryError } from "../domain/errors.js"
import type { SchemaField } from "../domain/google.js"
import { partitionFloor, probeSelect, tablePath } from "../domain/probe.js"
import type { Ports } from "../ports.js"
import type { TtlCache } from "./cache.js"
import { type TableFacts, widestFirst } from "./tables.js"

/** The row-access answer for one table. */
export type RowVerdict =
  | { readonly state: "none" }
  | { readonly state: "secured"; readonly how: "policy" | "zero-bytes" | "tabledata" | "denied" }
  | { readonly state: "unknown"; readonly why: string }

type Probe =
  | { readonly kind: "bytes"; readonly bytes: number }
  | { readonly kind: "column-denied"; readonly column?: string }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown"; readonly why: string }

/** A policy tag resource name, as Google's column-level denial carries it. */
const POLICY_TAG = /policy\s*tags?|policyTags?\//i

const lower = (name: string) => name.toLowerCase()

/** A column or path, backquoted with its own backquotes and backslashes escaped, as `src/domain/probe.ts` does. */
const quote = (name: string) => `\`${name.replace(/[\\`]/g, (char) => `\\${char}`)}\``

export interface RowPolicyDeps {
  readonly ports: Ports
  readonly account: string
  /** The project the probes' dry runs run in: the account's billing project. */
  readonly project: string
  readonly signal: AbortSignal
}

export class RowPolicyProber {
  constructor(
    private readonly deps: RowPolicyDeps,
    private readonly cache: TtlCache<RowVerdict>,
  ) {}

  async probe(facts: TableFacts): Promise<RowVerdict> {
    // A view has no policy of its own, and an external table has no BigQuery storage to filter; their bases are
    // checked where they are expanded, and the cap is already unenforceable for an external table.
    if (facts.kind === "view") return { state: "none" }
    if (facts.storage === "external") return { state: "none" }

    const key = `${this.deps.account}|${facts.name}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const verdict = await this.check(facts)
    return this.cache.set(key, verdict)
  }

  private async check(facts: TableFacts): Promise<RowVerdict> {
    // 1. Metadata, where the caller may read it: definitive.
    try {
      const page = await this.deps.ports.bigquery.listRowAccessPolicies(this.deps.account, facts.info.tableReference, this.deps.signal)
      return page.items.length > 0 ? { state: "secured", how: "policy" } : { state: "none" }
    } catch (error) {
      // A Data Viewer gets 403; any other failure means the answer is not knowable from metadata, so probe instead.
      if (!(error instanceof BigQueryError) || error.code !== "PERMISSION_DENIED") return this.dryPhase(facts)
    }
    return this.dryPhase(facts)
  }

  /** 2. The free dry-run probe, dropping a denied column and trying again rather than calling the table row-secured. */
  private async dryPhase(facts: TableFacts): Promise<RowVerdict> {
    const denied = new Set<string>()
    const excluded = () => new Set([...facts.tagged.map(lower), ...denied])
    for (let attempt = 0; attempt <= facts.columns.length + 1; attempt += 1) {
      const readable = facts.columns.filter((column) => !excluded().has(lower(column.name)))
      if (readable.length === 0) {
        // Every column is tagged (or was denied): probe the tagged columns themselves, widest type first.
        const candidates = facts.columns.filter((column) => facts.tagged.some((name) => lower(name) === lower(column.name)) && !denied.has(lower(column.name)))
        return this.oneByOne(facts, widestFirst(candidates))
      }
      const probe = await this.dry(this.probeSql(facts, excluded()), facts)
      if (probe.kind === "bytes") {
        if (probe.bytes > 0 || facts.numBytes === 0) return this.tabledata(facts, readable)
        return { state: "secured", how: "zero-bytes" }
      }
      if (probe.kind === "refused") return { state: "secured", how: "denied" }
      if (probe.kind === "column-denied") {
        if (!probe.column) return { state: "unknown", why: "a column-level denial that does not name a readable column" }
        denied.add(lower(probe.column))
        continue
      }
      return { state: "unknown", why: probe.why }
    }
    return { state: "unknown", why: "a column-level denial on every readable column" }
  }

  /** Every column is tagged: one at a time, widest type first, until one clears the probe. */
  private async oneByOne(facts: TableFacts, candidates: readonly SchemaField[]): Promise<RowVerdict> {
    if (candidates.length === 0) return { state: "unknown", why: "the table has no column the probe may read" }
    const filter = facts.requirePartitionFilter && facts.partitioning ? partitionFloor(facts.partitioning) : undefined
    let answered = false
    for (const column of candidates) {
      const sql = `SELECT ${quote(column.name)} FROM ${tablePath(facts.info.tableReference)}${filter ? ` WHERE ${filter}` : ""}`
      const probe = await this.dry(sql, facts)
      if (probe.kind === "bytes") {
        answered = true
        if (probe.bytes > 0 || facts.numBytes === 0) return this.tabledata(facts, facts.columns.filter((field) => lower(field.name) === lower(column.name)))
        continue
      }
      if (probe.kind === "refused") return { state: "secured", how: "denied" }
      if (probe.kind === "column-denied") continue
      return { state: "unknown", why: probe.why }
    }
    if (!answered) return { state: "unknown", why: "no column the probe may read" }
    return { state: "secured", how: "zero-bytes" }
  }

  /**
   * 3. `tabledata.list` with no rows, which needs the `TRUE` filter on a row-secured table.
   *
   * The port has no filter argument. Whether Google refuses `maxResults: 0` on a row-secured table without the filter —
   * a refusal is what C reads as row-secured — or answers it is a known limit in docs/architecture.md; when it answers,
   * the dry-run signal decides.
   */
  private async tabledata(facts: TableFacts, readable: readonly SchemaField[]): Promise<RowVerdict> {
    const column = readable.find((field) => field.name.length > 0)
    if (!column) return { state: "unknown", why: "the table has no untagged column to probe" }
    try {
      await this.deps.ports.bigquery.listTableData(this.deps.account, facts.info.tableReference, { maxResults: 0, selectedFields: [column.name] }, this.deps.signal)
      return { state: "none" }
    } catch (error) {
      if (error instanceof BigQueryError && (error.code === "PERMISSION_DENIED" || error.code === "COLUMN_DENIED")) return { state: "secured", how: "tabledata" }
      return { state: "unknown", why: "the tabledata.list probe errored" }
    }
  }

  private probeSql(facts: TableFacts, excluded: ReadonlySet<string>): string {
    const filter = facts.requirePartitionFilter && facts.partitioning ? partitionFloor(facts.partitioning) : undefined
    return probeSelect(facts.info.tableReference, [...excluded], filter)
  }

  private async dry(sql: string, facts: TableFacts): Promise<Probe> {
    try {
      const answer = await this.deps.ports.bigquery.dryRun(
        {
          account: this.deps.account,
          project: this.deps.project,
          sql,
          ...(facts.location !== undefined ? { location: facts.location } : {}),
        },
        this.deps.signal,
      )
      return { kind: "bytes", bytes: Number(answer.statistics?.totalBytesProcessed ?? "0") }
    } catch (error) {
      const denial = columnDenial(error, facts.columns)
      if (denial !== undefined) return { kind: "column-denied", ...(denial ? { column: denial } : {}) }
      if (error instanceof BigQueryError && (error.code === "PERMISSION_DENIED" || error.code === "COLUMN_DENIED")) return { kind: "refused" }
      return { kind: "unknown", why: "a probe dry run errored in a way this version does not classify" }
    }
  }
}

/**
 * The column a column-level denial names, from Google's message (untrusted text, used only to narrow the next probe,
 * never in a `message` or `next`): a policy tag is mentioned, and exactly one of the table's columns appears quoted, or
 * failing that as a whole word. `""` when a policy tag is named but the column cannot be identified; `undefined` when
 * the error is not a column-level denial, which means a refusal for another reason and is row-secured.
 */
function columnDenial(error: unknown, columns: readonly SchemaField[]): string | undefined | "" {
  if (!(error instanceof BigQueryError)) return undefined
  if (error.code !== "COLUMN_DENIED" && error.code !== "PERMISSION_DENIED") return undefined
  const message = error.extras.googleError?.message
  if (message === undefined) return error.code === "COLUMN_DENIED" ? "" : undefined
  if (!POLICY_TAG.test(message)) return undefined
  const known = new Set(columns.map((column) => lower(column.name)))
  const quoted = new Set<string>()
  for (const match of message.matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
    const name = match[1] ?? ""
    if (known.has(lower(name))) quoted.add(name)
  }
  if (quoted.size === 1) return [...quoted][0]!
  if (quoted.size > 1) return ""
  const words = new Set(message.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
  const named = columns.filter((column) => words.has(lower(column.name))).map((column) => column.name)
  return named.length === 1 ? named[0]! : ""
}
