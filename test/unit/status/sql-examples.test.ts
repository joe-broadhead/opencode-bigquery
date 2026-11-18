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
