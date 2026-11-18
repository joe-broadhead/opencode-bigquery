// Design §14.1, paging: a page is asked for one row more than the model may see, so a full page proves there is more
// (§7). The rows are then shaped by values.inlineRows, which reads the extra row as truncation.
import { describe, expect, test } from "vitest"
import type { SchemaField } from "../../../src/domain/google.js"
import { pageSize } from "../../../src/process/paging.js"
import { convertRows, inlineRows } from "../../../src/process/values.js"
import { row } from "../../fake/bigquery.js"

describe("paging", () => {
  test("asks for one row more than the model may see", () => {
    expect(pageSize(50)).toBe(51)
    expect(pageSize(500)).toBe(501)
    expect(pageSize(1)).toBe(2)
  })

  test("the extra row is what proves a page was cut", () => {
    const fields: SchemaField[] = [{ name: "id", type: "INT64" }]
    const rows = convertRows(fields, [row("1"), row("2"), row("3")])
    const fit = inlineRows(fields, rows, { maxRows: 2, maxInlineBytes: 32 * 1024 })
    expect(fit.rows).toEqual([[1], [2]])
    expect(fit.truncated).toEqual({ rows: true, cells: false, bytes: false })
  })
})
