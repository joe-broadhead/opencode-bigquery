// Design §14.1, results, and §7's types: BigQuery's typed JSON becomes values, with INT64 exact beyond 2^53, NUMERIC
// and BIGNUMERIC as strings, TIMESTAMP ISO UTC to the microsecond across the whole range, RANGE as { start, end },
// JSON as its text, and ARRAY/STRUCT however nested. Inline cells are cut as §7 says.
import { describe, expect, test } from "vitest"
import type { SchemaField } from "../../../src/domain/google.js"
import { columns, convertRows, convertValue, inlineCell, inlineRows } from "../../../src/process/values.js"
import { fixture } from "./support.js"
import { row } from "../../fake/bigquery.js"

const page = fixture("results-page-1").response.body as { schema: { fields: SchemaField[] }; rows: unknown[] }
const fields = page.schema.fields

describe("values", () => {
  test("converts every type of a result page", () => {
    const rows = convertRows(fields, page.rows)
    const first = rows[0]!
    expect(first.slice(0, 8)).toEqual([1, "9007199254740993", "123456789.123456789", "123456789012345678901234567890.123456789", 1.5, "NaN", true, "a string"])
    expect(first.slice(8)).toEqual([
      "aGVsbG8=",
      "2023-11-14T22:13:20.123456Z",
      "9999-12-31T23:59:59.999999Z",
      "0001-01-01T00:00:00.000Z",
      "2026-11-17",
      "2026-11-17T12:00:00",
      "12:00:00",
      '{"a":1}',
      "POINT(1 2)",
      { start: "2026-01-01", end: "2026-12-31" },
      ["one", "two"],
      { city: "Lisbon", zip: 1000 },
      [{ city: "Madrid" }, { city: "Porto" }],
      "0-0 0 0:0:0",
    ])
  })

  test("keeps nulls, empty arrays and unbounded ranges", () => {
    const second = convertRows(fields, page.rows)[1]!
    expect(second[1]).toBe("-9007199254740993")
    expect(second[4]).toBe("-Infinity")
    expect(second[5]).toBe("Infinity")
    expect(second[6]).toBe(false)
    expect(second[7]).toBe("")
    expect(second[9]).toBe("1970-01-01T00:00:00.000Z")
    expect(second[10]).toBeNull()
    expect(second[11]).toBeNull()
    expect(second[17]).toEqual({ start: null, end: "2026-01-01" })
    expect(second[18]).toEqual([])
    expect(second[19]).toBeNull()
    expect(second[20]).toEqual([])
  })

  test("INT64 is a number only when it is exactly representable", () => {
    const field: SchemaField = { name: "n", type: "INT64" }
    expect(convertValue(field, String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    expect(convertValue(field, String(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER)
    expect(convertValue(field, "9007199254740992")).toBe("9007199254740992")
    expect(convertValue(field, "-9007199254740992")).toBe("-9007199254740992")
  })

  test("FLOAT64 keeps NaN and the infinities as Google's text", () => {
    const field: SchemaField = { name: "f", type: "FLOAT64" }
    expect(convertValue(field, "1.5")).toBe(1.5)
    expect(convertValue(field, "1e3")).toBe(1000)
    expect(convertValue(field, "NaN")).toBe("NaN")
    expect(convertValue(field, "Infinity")).toBe("Infinity")
    expect(convertValue(field, "-Infinity")).toBe("-Infinity")
  })

  test("TIMESTAMP is exact across BigQuery's whole range, in both forms Google sends", () => {
    const field: SchemaField = { name: "ts", type: "TIMESTAMP" }
    // formatOptions.useInt64Timestamp: microseconds as an int64.
    expect(convertValue(field, "0")).toBe("1970-01-01T00:00:00.000Z")
    expect(convertValue(field, "1700000000123456")).toBe("2023-11-14T22:13:20.123456Z")
    expect(convertValue(field, "253402300799999999")).toBe("9999-12-31T23:59:59.999999Z")
    expect(convertValue(field, "-62135596800000000")).toBe("0001-01-01T00:00:00.000Z")
    expect(convertValue(field, "-500000")).toBe("1969-12-31T23:59:59.5Z")
    // The default form: seconds as a double in text, parsed exactly (a double rounds the 9999 sentinel into year 10000).
    expect(convertValue(field, "1.700000000123456E9")).toBe("2023-11-14T22:13:20.123456Z")
    expect(convertValue(field, "2.53402300799999999E11")).toBe("9999-12-31T23:59:59.999999Z")
    expect(convertValue(field, "-6.21355968E10")).toBe("0001-01-01T00:00:00.000Z")
    expect(convertValue(field, "1700000000.5")).toBe("2023-11-14T22:13:20.5Z")
    expect(convertValue(field, "-0.5")).toBe("1969-12-31T23:59:59.5Z")
  })

  test("the old type names mean the same types", () => {
    expect(convertValue({ name: "i", type: "INTEGER" }, "1")).toBe(1)
    expect(convertValue({ name: "f", type: "FLOAT" }, "1.5")).toBe(1.5)
    expect(convertValue({ name: "b", type: "BOOLEAN" }, "true")).toBe(true)
    expect(convertValue({ name: "r", type: "RECORD", fields: [{ name: "x", type: "STRING" }] }, { f: [{ v: "y" }] })).toEqual({ x: "y" })
  })

  test("columns are the schema's names and types, in order", () => {
    expect(columns(fields).slice(0, 2)).toEqual([
      { name: "id", type: "INT64" },
      { name: "big", type: "INT64" },
    ])
  })

  test("inline cells are cut to 200 characters, ARRAY and STRUCT as their JSON text", () => {
    const third = convertRows(fields, page.rows)[2]!
    const name = inlineCell(fields[7], third[7])
    expect(typeof name).toBe("string")
    expect((name as string).length).toBe(200)
    expect((name as string).endsWith("…")).toBe(true)
    const tags = inlineCell(fields[18], ["one", "two"])
    expect(tags).toBe('["one","two"]')
  })

  test("a BYTES cell is cut to 64, control characters are escaped, and a cut never splits a character", () => {
    expect(inlineCell({ name: "b", type: "BYTES" }, "a".repeat(100))).toBe(`${"a".repeat(63)}…`)
    expect(inlineCell({ name: "s", type: "STRING" }, "a\u0007b")).toBe("a\\u0007b")
    expect(inlineCell({ name: "s", type: "STRING" }, "tab\tnewline\n")).toBe("tab\tnewline\n")
    // A four-byte emoji is two UTF-16 units; a cut between them would leave a lone surrogate.
    const emoji = "😀"
    const text = `${"a".repeat(198)}${emoji}b`
    const cut = inlineCell({ name: "s", type: "STRING" }, text) as string
    expect(cut.length).toBeLessThanOrEqual(200)
    expect(cut.endsWith("…")).toBe(true)
    expect(cut.slice(0, -1)).toBe("a".repeat(198))
    expect(cut.slice(0, -1)).not.toContain("\ud83d")
  })

  test("inline rows stop at maxRows, then at the byte budget, and say which", () => {
    const rows = convertRows(fields, page.rows)
    const byRows = inlineRows(fields, rows, { maxRows: 2, maxInlineBytes: 32 * 1024 })
    expect(byRows.rows).toHaveLength(2)
    expect(byRows.truncated).toEqual({ rows: true, cells: false, bytes: false })

    const all = inlineRows(fields, rows, { maxRows: 3, maxInlineBytes: 32 * 1024 })
    expect(all.rows).toHaveLength(3)
    expect(all.truncated).toEqual({ rows: false, cells: true, bytes: false })

    const byBytes = inlineRows(fields, rows, { maxRows: 3, maxInlineBytes: 50 })
    expect(byBytes.rows).toHaveLength(0)
    expect(byBytes.truncated).toEqual({ rows: true, cells: false, bytes: true })
  })

  test("inline shaping does not change the values it is given", () => {
    const value = { city: "Lisbon", zip: 1000 }
    inlineCell({ name: "a", type: "RECORD" }, value)
    expect(value).toEqual({ city: "Lisbon", zip: 1000 })
    expect(convertRows(fields, [row("1", "2")])[0]!.slice(0, 2)).toEqual([1, 2])
  })
})
