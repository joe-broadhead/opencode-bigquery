// The read path's remaining evidence: the post-run drift check and its cache drop (§14.1 "Expansion freshness"),
// the hints (§6.3), the concurrency cap (§6.2 item 5), parameter typing, and result shaping (§7).
import { describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { hintsFor } from "../../../src/guards/hints.js"
import { createLexer, hasKeyword } from "../../../src/guards/lexer.js"
import { Limiter } from "../../../src/guards/limits.js"
import { toQueryParameters, parameterMode } from "../../../src/guards/params.js"
import { cellValue, sanitise, shapeRows } from "../../../src/guards/results.js"
import { tableFacts } from "../../../src/guards/tables.js"
import { callsOf, harness, jobStatus, nativeTable, runTool, scriptNativeRead, statistics, tableRef } from "../reads/support.js"
import { needsPlan } from "../reads/expect.js"

const SQL = "SELECT id, amount FROM `invented-proj.sales.orders`"

describe("the post-run drift check (review R2-L1)", () => {
  it("records CLASSIFICATION_DRIFT when the job referenced a view expansion did not see, and drops the expansion cache", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { status: jobStatus({ referencedLogicalViews: [tableRef("redefined")] }) })
    const first = await runTool(h, "query", { sql: SQL })
    expect(first.output).toMatchObject({ state: "failed", error: "CLASSIFICATION_DRIFT" })
    expect(String(first.output.message)).toContain("`redefined`")
    expect(first.output).toMatchObject({ bytesBilled: 1048576, job: { jobId: expect.any(String) } })
    // The cache was dropped: the next call fetches the table again.
    await runTool(h, "query", { sql: SQL })
    expect(callsOf(h.bigquery, "getTable")).toHaveLength(2)
  })

  it("records CLASSIFICATION_DRIFT when the job's statement type differs from its dry run", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { status: jobStatus({ statementType: "SCRIPT" }) })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output).toMatchObject({ state: "failed", error: "CLASSIFICATION_DRIFT" })
    expect(String(output.message)).toContain("SCRIPT")
  })

  it("does not drift when the job's lists are what the dry run and expansion saw", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { status: jobStatus({ referencedLogicalViews: [] }) })
    expect((await runTool(h, "query", { sql: SQL })).output).toMatchObject({ state: "done" })
  })
})

describe("the hints (§6.3)", () => {
  const findings = (sql: string) => {
    const lexed = createLexer().lex(sql)
    if (!lexed.ok) throw new Error(sql)
    return createLexer().findings(lexed.tokens)
  }
  const partitioned = tableFacts(
    nativeTable({
      schema: { fields: [{ name: "day", type: "DATE" }, { name: "id", type: "INT64" }] },
      timePartitioning: { type: "DAY", field: "day" },
      clustering: { fields: ["id"] },
      numBytes: "1000",
    }),
  )

  it("names a partitioned table's column, a clustered table's columns, LIMIT, * and the cache", () => {
    const hints = hintsFor({ findings: findings("SELECT * FROM t LIMIT 10"), tables: [partitioned], bytes: 1000, hasLimit: true, useCache: false })
    expect(hints).toHaveLength(5)
    expect(hints[0]).toContain("partitioned on `day`")
    expect(hints[1]).toContain("clustered on `id`")
    expect(hints[2]).toContain("LIMIT")
    expect(hints[3]).toContain("SELECT *")
    expect(hints[4]).toContain("cache is off")
    expect(hintsFor({ findings: findings("SELECT id FROM t"), tables: [partitioned], bytes: 1000, hasLimit: false, useCache: true })).toEqual([
      expect.stringContaining("partitioned on `day`"),
      expect.stringContaining("clustered on `id`"),
    ])
  })

  it("says nothing when the query reads a small part of a table", () => {
    expect(hintsFor({ findings: findings("SELECT id FROM t"), tables: [partitioned], bytes: 100, hasLimit: false, useCache: true })).toEqual([])
  })

  it("reads LIMIT from the lexer, not from a string search", () => {
    const quoted = createLexer().lex("SELECT 'LIMIT' FROM t")
    expect(quoted.ok && hasKeyword(quoted.tokens, "LIMIT")).toBe(false)
    const lexed = createLexer().lex("SELECT id FROM t LIMIT 1")
    expect(lexed.ok && hasKeyword(lexed.tokens, "LIMIT")).toBe(true)
  })
})

describe("the job concurrency cap (§6.2 item 5)", () => {
  it("lets at most the cap in flight, and a stopped call leaves the queue", async () => {
    const limiter = new Limiter(2)
    let active = 0
    let peak = 0
    const work = async () => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
    }
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(new AbortController().signal, work)))
    expect(peak).toBe(2)
    expect(limiter.inFlight()).toBe(0)

    const one = new Limiter(1)
    const signal = new AbortController()
    const held = one.run(new AbortController().signal, () => new Promise<void>((resolve) => setTimeout(resolve, 5)))
    const queued = one.run(signal.signal, work)
    signal.abort()
    await expect(queued).rejects.toBeInstanceOf(BigQueryError)
    await held
    expect(one.inFlight()).toBe(0)
  })
})

describe("query parameters", () => {
  it("types strings, booleans, integers, floats and arrays, and sorts named parameters", () => {
    expect(toQueryParameters({ b: true, a: "x" })).toEqual([
      { name: "a", parameterType: { type: "STRING" }, parameterValue: { value: "x" } },
      { name: "b", parameterType: { type: "BOOL" }, parameterValue: { value: "true" } },
    ])
    expect(toQueryParameters([1, 2])).toEqual([
      { parameterType: { type: "INT64" }, parameterValue: { value: "1" } },
      { parameterType: { type: "INT64" }, parameterValue: { value: "2" } },
    ])
    expect(toQueryParameters([1.5, "2026-01-01"])).toEqual([
      { parameterType: { type: "FLOAT64" }, parameterValue: { value: "1.5" } },
      { parameterType: { type: "STRING" }, parameterValue: { value: "2026-01-01" } },
    ])
    expect(toQueryParameters({ xs: ["a", "b"] })).toEqual([
      { name: "xs", parameterType: { type: "ARRAY", arrayType: { type: "STRING" } }, parameterValue: { arrayValues: [{ value: "a" }, { value: "b" }] } },
    ])
    expect(parameterMode({ a: 1 })).toBe("NAMED")
    expect(parameterMode([1])).toBe("POSITIONAL")
    expect(parameterMode(undefined)).toBeUndefined()
    expect(toQueryParameters(undefined)).toBeUndefined()
    expect(toQueryParameters({})).toBeUndefined()
  })

  it("refuses a value whose type it cannot know rather than guessing", () => {
    for (const params of [{ s: { a: 1 } }, { n: null }, { xs: [] }, { nested: [[1]] }, { mixed: [1, "x"] }, { nan: Number.NaN }, { big: 9007199254740993 }, { many: [9007199254740992] }]) {
      expect(() => toQueryParameters(params as never), JSON.stringify(params)).toThrow(/INPUT_INVALID/)
    }
    // An integer above 2^53 loses precision as a JSON number: the hint names the CAST (review LOW 6).
    expect(() => toQueryParameters({ big: 9007199254740993 })).toThrow(/CAST/)
  })
})

describe("result shaping (§7)", () => {
  it("converts every type, and cuts a nested value as JSON", () => {
    expect(cellValue("9223372036854775807", { name: "n", type: "INT64" }).value).toBe("9223372036854775807")
    expect(cellValue("12", { name: "n", type: "INT64" }).value).toBe(12)
    expect(cellValue("1.5", { name: "n", type: "NUMERIC" }).value).toBe("1.5")
    expect(cellValue("NaN", { name: "f", type: "FLOAT64" }).value).toBe("NaN")
    expect(cellValue("true", { name: "b", type: "BOOL" }).value).toBe(true)
    expect(cellValue("1763380800", { name: "t", type: "TIMESTAMP" }).value).toBe("2025-11-17T12:00:00.000Z")
    expect(cellValue([{ v: "a" }], { name: "xs", type: "STRING", mode: "REPEATED" }).value).toBe('[{"v":"a"}]')
    expect(cellValue("x".repeat(300), { name: "s", type: "STRING" })).toEqual({ value: `${"x".repeat(199)}…`, cut: true })
    expect(cellValue("y".repeat(100), { name: "b", type: "BYTES" }).value).toHaveLength(64)
  })

  it("escapes control characters but keeps tab and newline", () => {
    expect(sanitise("a\u0000b\tc\nd\u001f")).toBe("a\\u0000b\tc\nd\\u001f")
  })

  it("stops at the inline byte cap and says so", () => {
    const shaped = shapeRows({ schema: [{ name: "s", type: "STRING" }], rows: Array.from({ length: 20 }, () => ({ f: [{ v: "x".repeat(50) }] })), maxRows: 20, maxInlineBytes: 120 })
    expect(shaped.rows.length).toBeLessThan(20)
    expect(shaped.truncated.bytes).toBe(true)
  })

  it("does not mistake a STRUCT whose field is named v for Google's cell wrapper", () => {
    const shaped = shapeRows({ schema: [{ name: "s", type: "STRUCT" }], rows: [[{ v: "x", other: 1 }]], maxRows: 5, maxInlineBytes: 1024 })
    expect(JSON.parse(String(shaped.rows[0]![0]))).toEqual({ v: "x", other: 1 })
  })

  it("treats an already-converted row as a row", () => {
    const shaped = shapeRows({ schema: [{ name: "n", type: "INT64" }], rows: [[1], [2]], maxRows: 50, maxInlineBytes: 1024 })
    expect(shaped.rows).toEqual([[1], [2]])
    expect(shaped.columns).toEqual([{ name: "n", type: "INT64" }])
  })
})

describe("the payment the read path makes for a cap it cannot prove", () => {
  it("names the condition in the refusal, and says what to do", async () => {
    const h = harness()
    const external = nativeTable({ externalDataConfiguration: { sourceUris: ["gs://invented/x.csv"] } })
    scriptNativeRead(h.bigquery, { table: external, statistics: statistics({ totalBytesProcessedAccuracy: "PRECISE" }) })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(needsPlan(output)).toBe("CAP_NOT_ENFORCEABLE")
    expect(String(output.message)).toContain("`invented-proj`.`sales`.`orders`")
    expect(String(output.next)).toContain("bigquery_plan")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("warns ESTIMATE_LOWER_BOUND on a source read only when it ran", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    const { output } = await runTool(h, "query", { sql: SQL })
    expect((output.warnings as { code: string }[] | undefined)?.map((item) => item.code) ?? []).not.toContain("ESTIMATE_LOWER_BOUND")
  })
})

