// Every SQL example the docs and the SQL skill show runs through the plugin's own read path on the Day 0 fakes, so an
// example the plugin refuses — or one that is not a complete statement — fails the build (review bigquery-12, M-1).
// The two files must carry the same examples, so one cannot drift from the other.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { harness, runTool, scriptNativeRead } from "../reads/support.js"

const FILES = ["docs/sql.md", "skills/opencode-bigquery-sql/SKILL.md"]
const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8")

/** A fenced `sql` block, at any indentation (the worked examples sit inside a list). */
const BLOCK = /^[ \t]*```sql[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gm
/** A block's own parameter values, as a comment: `-- Run with params: { "corpus": "hamlet" }`. */
const PARAMS = /^[ \t]*--[^\n]*?params:\s*(\{[^\n]*\})\s*$/im

type Example = { readonly file: string; readonly index: number; readonly sql: string; readonly params?: Record<string, unknown> }

/**
 * The columns each `INFORMATION_SCHEMA` view the examples use is documented to have, from Google's pages (fetched
 * 18 Nov 2026). The fake cannot catch a wrong column — it answers every dry run as a native `SELECT` — so the examples
 * are checked here against the documented schemas (review bigquery-12, M-1).
 */
const INFORMATION_SCHEMA: Readonly<Record<string, { readonly cite: string; readonly columns: readonly string[] }>> = {
  TABLES: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-tables",
    columns: [
      "table_catalog", "table_schema", "table_name", "table_type", "managed_table_type", "is_insertable_into",
      "is_fine_grained_mutations_enabled", "is_typed", "is_change_history_enabled", "creation_time",
      "base_table_catalog", "base_table_schema", "base_table_name", "snapshot_time_ms", "replica_source_catalog",
      "replica_source_schema", "replica_source_name",
    ],
  },
  TABLE_STORAGE: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-table-storage",
    columns: [
      "project_id", "project_number", "table_catalog", "table_schema", "table_name", "creation_time", "total_rows",
      "total_partitions", "total_logical_bytes", "active_logical_bytes", "long_term_logical_bytes",
      "current_physical_bytes", "total_physical_bytes", "active_physical_bytes", "long_term_physical_bytes",
      "time_travel_physical_bytes", "storage_last_modified_time", "deleted", "table_type", "managed_table_type",
      "fail_safe_physical_bytes", "last_metadata_index_refresh_time",
    ],
  },
  COLUMN_FIELD_PATHS: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-column-field-paths",
    columns: ["table_catalog", "table_schema", "table_name", "column_name", "field_path", "data_type", "description", "collation_name", "rounding_mode", "data_governance_tags", "policy_tags"],
  },
  PARTITIONS: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-partitions",
    columns: ["table_catalog", "table_schema", "table_name", "partition_id", "total_rows", "total_logical_bytes", "total_billable_bytes", "last_modified_time", "storage_tier"],
  },
}

const SELECT = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s+/i
const VIEW = /INFORMATION_SCHEMA\.([A-Za-z_][A-Za-z0-9_]*)/i
const BARE_COLUMN = /^`?([A-Za-z_][A-Za-z0-9_]*)`?$/

/** The selected items of a `SELECT col, col AS a, expr FROM …` list, split at depth 0. */
function selectItems(sql: string): string[] {
  const list = SELECT.exec(sql)?.[1]
  if (list === undefined) return []
  const items: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === "`") quote = char
    else if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth -= 1
    else if (char === "," && depth === 0) {
      items.push(list.slice(start, index))
      start = index + 1
    }
  }
  items.push(list.slice(start))
  return items
}

type ColumnProblem = { readonly name: string; readonly view: string; readonly cite: string }

/** A selected bare column that the referenced `INFORMATION_SCHEMA` view does not document. */
function columnProblems(example: Example): ColumnProblem[] {
  const match = VIEW.exec(example.sql)
  if (match === null) return []
  const view = match[1]!.toUpperCase()
  const documented = INFORMATION_SCHEMA[view]
  if (documented === undefined) return [{ name: `the view ${view}`, view, cite: "add its Google page to this test" }]
  return selectItems(example.sql)
    .map((item) => BARE_COLUMN.exec(item.split(/\s+AS\s+/i)[0]!.trim())?.[1])
    .filter((name): name is string => name !== undefined)
    .filter((name) => !documented.columns.includes(name))
    .map((name) => ({ name, view, cite: documented.cite }))
}

function examples(file: string): Example[] {
  const text = read(file)
  return [...text.matchAll(BLOCK)].map((match, index) => {
    const sql = match[1]!
    const params = PARAMS.exec(sql)?.[1]
    return { file, index: index + 1, sql: sql.trim(), ...(params !== undefined ? { params: JSON.parse(params) as Record<string, unknown> } : {}) }
  })
}

describe("the documented SQL examples", () => {
  it("are the same in docs/sql.md and the SQL skill", () => {
    for (const file of FILES) expect(examples(file).length, file).toBeGreaterThan(10)
    expect(examples(FILES[1]!).map((example) => example.sql)).toEqual(examples(FILES[0]!).map((example) => example.sql))
  })

  it("select only columns Google documents for each INFORMATION_SCHEMA view", () => {
    const used = new Set<string>()
    for (const file of FILES) {
      for (const example of examples(file)) {
        for (const problem of columnProblems(example)) {
          throw new Error(`${example.file} #${example.index}: INFORMATION_SCHEMA.${problem.view} has no \`${problem.name}\` (${problem.cite})`)
        }
        const match = VIEW.exec(example.sql)
        if (match !== null) used.add(match[1]!.toUpperCase())
      }
    }
    // Every view this test documents is used, and a new one must be added here with its page.
    expect([...used].sort()).toEqual(["COLUMN_FIELD_PATHS", "PARTITIONS", "TABLES", "TABLE_STORAGE"])
  })

  it("refuses a column a documented view does not have", () => {
    const bad = { file: "test", index: 0, sql: "SELECT table_name, size_bytes FROM `invented.INFORMATION_SCHEMA.TABLES`" }
    expect(columnProblems(bad)).toEqual([{ name: "size_bytes", view: "TABLES", cite: INFORMATION_SCHEMA.TABLES!.cite }])
  })

  it("every one is a complete statement the plugin's read path accepts", async () => {
    for (const file of FILES) {
      for (const example of examples(file)) {
        const h = harness()
        scriptNativeRead(h.bigquery)
        const { output } = await runTool(h, "query", { sql: example.sql, ...(example.params !== undefined ? { params: example.params } : {}) })
        expect([`${file} #${example.index}`, output.state, output.error]).toEqual([`${file} #${example.index}`, "done", undefined])
      }
    }
  })
})
