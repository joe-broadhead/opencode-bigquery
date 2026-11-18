// Package E's contract requests (review bigquery-9) that master did not already carry with E's merge: the probe owner
// holds back `verified`, a table's streaming buffer reaches the contract, and the source codes map. (`source` on the
// probe and saved_list, `bigquery.read` and `Page.unreachable` came with E's merge, with E's own tests.)
import { describe, expect, it } from "vitest"
import { ProbeOutput } from "../../src/domain/contract.js"
import { SOURCE_CODE } from "../../src/domain/errors.js"
import type { TableInfo } from "../../src/domain/google.js"

describe("package E's contract requests", () => {
  it("holds back the probe owner's verified: false until consumers read v0.2.0", () => {
    expect(Object.keys(ProbeOutput.shape)).toEqual(["owner"])
  })

  it("carries a table's streaming buffer", () => {
    const table: TableInfo = { tableReference: { projectId: "invented-project", datasetId: "d", tableId: "t" }, streamingBuffer: { estimatedRows: "12", estimatedBytes: "3400", oldestEntryTime: "1763377200000" } }
    expect(table.streamingBuffer?.estimatedRows).toBe("12")
  })

  it("maps BILLING_PROJECT_REQUIRED and NOT_FOUND to the source contract's INPUT_INVALID", () => {
    expect(SOURCE_CODE.BILLING_PROJECT_REQUIRED).toBe("INPUT_INVALID")
    expect(SOURCE_CODE.NOT_FOUND).toBe("INPUT_INVALID")
  })
})
