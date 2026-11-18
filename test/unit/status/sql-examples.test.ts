// Every SQL example the docs and the SQL skill show runs through the plugin's own read path on the Day 0 fakes, so an
// example the plugin refuses — or one that is not a complete statement — fails the build (review bigquery-12, M-1).
// The two files must carry the same examples, so one cannot drift from the other.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Token } from "../../../src/domain/lexer-api.js"
import { informationSchemaRefs, lexText, significantTokens } from "../../../src/guards/lexer.js"
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
 * are checked here against the documented schemas (review bigquery-12, M-1 and LOW 2).
 */
const INFORMATION_SCHEMA: Readonly<Record<string, { readonly cite: string; readonly columns: readonly string[] }>> = {
  TABLES: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-tables",
    columns: [
      "table_catalog", "table_schema", "table_name", "table_type", "managed_table_type", "is_insertable_into",
      "is_fine_grained_mutations_enabled", "is_typed", "is_change_history_enabled", "creation_time",
      "base_table_catalog", "base_table_schema", "base_table_name", "snapshot_time_ms", "replica_source_catalog",
      "replica_source_schema", "replica_source_name", "replication_status", "replication_error", "ddl",
      "default_collation_name", "sync_status", "upsert_stream_apply_watermark",
    ],
  },
  TABLE_STORAGE: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-table-storage",
    columns: [
      "project_id", "project_number", "table_catalog", "table_schema", "table_name", "creation_time", "total_rows",
      "total_partitions", "total_logical_bytes", "active_logical_bytes", "long_term_logical_bytes",
      "current_physical_bytes", "total_physical_bytes", "active_physical_bytes", "long_term_physical_bytes",
      "time_travel_physical_bytes", "storage_last_modified_time", "deleted", "table_type", "managed_table_type",
      "fail_safe_physical_bytes", "last_metadata_index_refresh_time", "table_deletion_reason", "table_deletion_time",
    ],
  },
  COLUMN_FIELD_PATHS: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-column-field-paths",
    columns: [
      "table_catalog", "table_schema", "table_name", "column_name", "field_path", "data_type", "description",
      "collation_name", "rounding_mode", "data_governance_tags", "policy_tags", "data_policies.name",
    ],
  },
  PARTITIONS: {
    cite: "https://cloud.google.com/bigquery/docs/information-schema-partitions",
    columns: ["table_catalog", "table_schema", "table_name", "partition_id", "total_rows", "total_logical_bytes", "total_billable_bytes", "last_modified_time", "storage_tier"],
  },
}

/** The clauses that end a `FROM` item list, and words that are never a column reference. */
const CLAUSE_END: ReadonlySet<string> = new Set(["WHERE", "GROUP", "ORDER", "HAVING", "QUALIFY", "LIMIT", "WINDOW", "UNION", "INTERSECT", "EXCEPT"])
/** Words the lexer may hand back as identifiers (it does for `WHERE`) that are still not columns. */
const NOT_A_COLUMN: ReadonlySet<string> = new Set([...CLAUSE_END, "BY", "ASC", "DESC", "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "BETWEEN", "LIKE", "ON", "USING"])

const isWord = (token: Token | undefined): token is Token => token !== undefined && (token.kind === "identifier" || token.kind === "quoted")
const isPunct = (token: Token | undefined, text: string) => token !== undefined && (token.kind === "punctuation" || token.kind === "operator") && token.text === text
const nameOf = (token: Token): string => (token.kind === "quoted" ? (token.parts?.length === 1 ? token.parts[0]! : (token.parts ?? [token.value]).join(".")) : token.text)

/** The index just past a `FROM` item list (its first clause keyword at depth 0), or the end. */
function fromEnd(tokens: readonly Token[], start: number): number {
  let depth = 0
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (isPunct(token, "(") || isPunct(token, "[")) depth += 1
    else if (isPunct(token, ")") || isPunct(token, "]")) depth -= 1
    else if (depth === 0 && (token.kind === "keyword" || token.kind === "identifier") && CLAUSE_END.has(token.value.toUpperCase())) return index
  }
  return tokens.length
}

/**
 * Every column a statement references outside its `FROM` items: the select list, `WHERE`, `GROUP BY`, `HAVING`,
 * `ORDER BY`, `QUALIFY` and `LIMIT`. A dotted `t.col` reference is checked as `t.col` and as `col`; keywords, function
 * names and the statement's own aliases are skipped (review bigquery-12, LOW 1).
 */
function referencedColumns(tokens: readonly Token[]): string[] {
  const aliases = new Set<string>()
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index]!.kind === "keyword" && tokens[index]!.value.toUpperCase() === "AS" && isWord(tokens[index + 1])) aliases.add(nameOf(tokens[index + 1]!).toLowerCase())
  }
  const from = tokens.findIndex((token) => token.kind === "keyword" && token.value.toUpperCase() === "FROM")
  const skipFrom = from < 0 ? -1 : from
  const skipTo = from < 0 ? -1 : fromEnd(tokens, from)
  const out: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (index >= skipFrom && index < skipTo) continue
    if (!isWord(tokens[index])) continue
    // The start of a dotted chain only; its qualifiers are the earlier parts, and the last part is the reference.
    if (isPunct(tokens[index - 1], ".")) continue
    const parts: string[] = [nameOf(tokens[index]!)]
    let end = index
    while (isPunct(tokens[end + 1], ".") && isWord(tokens[end + 2])) {
      end += 2
      parts.push(nameOf(tokens[end]!))
    }
    if (isPunct(tokens[end + 1], "(")) continue // a function or a method call
    if (NOT_A_COLUMN.has(parts.at(-1)!.toUpperCase())) continue
    const last = parts.at(-1)!
    if (aliases.has(last.toLowerCase()) || aliases.has(parts.join(".").toLowerCase())) continue
    out.push(parts.join("."))
  }
  return out
}

type ColumnProblem = { readonly name: string; readonly view: string; readonly cite: string }

/** A column a statement references that the referenced `INFORMATION_SCHEMA` view does not document. */
function columnProblems(example: Example): ColumnProblem[] {
  const lexed = lexText(example.sql)
  if (!lexed.ok) return []
  const tokens = significantTokens(lexed.tokens)
  const refs = informationSchemaRefs(tokens)
  if (refs.length === 0) return []
  const view = refs[0]!.parts.at(-1)!.toUpperCase()
  const documented = INFORMATION_SCHEMA[view]
  if (documented === undefined) return [{ name: view, view, cite: "add its Google page to this test" }]
  const columns = documented.columns.map((column) => column.toLowerCase())
  return referencedColumns(tokens)
    .filter((name) => !columns.includes(name.toLowerCase()) && !columns.includes(name.split(".").at(-1)!.toLowerCase()))
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

  it("reference only columns Google documents for each INFORMATION_SCHEMA view", () => {
    const used = new Set<string>()
    for (const file of FILES) {
      for (const example of examples(file)) {
        for (const problem of columnProblems(example)) {
          throw new Error(`${example.file} #${example.index}: INFORMATION_SCHEMA.${problem.view} has no \`${problem.name}\` (${problem.cite})`)
        }
        const lexed = lexText(example.sql)
        if (lexed.ok) for (const ref of informationSchemaRefs(significantTokens(lexed.tokens))) used.add(ref.parts.at(-1)!.toUpperCase())
      }
    }
    // Every view this test documents is used, and a new one must be added here with its page.
    expect([...used].sort()).toEqual(["COLUMN_FIELD_PATHS", "PARTITIONS", "TABLES", "TABLE_STORAGE"])
  })

  it("refuses a wrong column in the select list, in ORDER BY and behind a qualifier", () => {
    const bad = { file: "test", index: 0 }
    const problems = (sql: string) => columnProblems({ ...bad, sql }).map((problem) => problem.name)
    expect(problems("SELECT table_name, size_bytes FROM `invented.INFORMATION_SCHEMA.TABLES`")).toContain("size_bytes")
    expect(problems("SELECT table_name FROM `invented.INFORMATION_SCHEMA.TABLE_STORAGE` ORDER BY size_bytes")).toEqual(["size_bytes"])
    expect(problems("SELECT t.row_count FROM `invented.INFORMATION_SCHEMA.TABLE_STORAGE` AS t")).toEqual(["t.row_count"])
    expect(problems("SELECT table_name FROM `invented.INFORMATION_SCHEMA.TABLE_STORAGE` WHERE dataset_id = 'x'")).toEqual(["dataset_id"])
    expect(problems("SELECT COUNT(*) FROM `invented.INFORMATION_SCHEMA.TABLE_STORAGE` GROUP BY size_bytes")).toEqual(["size_bytes"])
    // A documented qualified column passes, and so does an alias order.
    expect(problems("SELECT t.total_rows AS rows FROM `invented.INFORMATION_SCHEMA.TABLE_STORAGE` AS t ORDER BY rows")).toEqual([])
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
