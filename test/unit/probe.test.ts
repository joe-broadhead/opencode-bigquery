// The row-policy probe's text: never `SELECT * EXCEPT ()`, and a partition filter that keeps every partition.
import { describe, expect, it } from "vitest"
import { partitionFloor, probeSelect } from "../../src/domain/probe.js"

const ref = { projectId: "invented-proj", datasetId: "sales", tableId: "orders" }

describe("the probe", () => {
  it("is plain SELECT * for a table with no tagged columns (review round 4, LOW 1)", () => {
    expect(probeSelect(ref, [])).toBe("SELECT * FROM `invented-proj.sales.orders`")
    expect(probeSelect(ref, [])).not.toContain("EXCEPT")
  })

  it("leaves the tagged columns out, each once and quoted", () => {
    expect(probeSelect(ref, ["ssn", "email", "ssn"])).toBe("SELECT * EXCEPT (`ssn`, `email`) FROM `invented-proj.sales.orders`")
    expect(probeSelect(ref, ["we`ird"])).toBe("SELECT * EXCEPT (`we\\`ird`) FROM `invented-proj.sales.orders`")
  })

  it("adds a partition filter from the type's minimum, keeping NULL partitions", () => {
    expect(probeSelect(ref, [], partitionFloor({ kind: "column", column: "day", type: "DATE" }))).toBe(
      "SELECT * FROM `invented-proj.sales.orders` WHERE `day` >= DATE '0001-01-01' OR `day` IS NULL",
    )
    expect(partitionFloor({ kind: "column", column: "at", type: "TIMESTAMP" })).toBe("`at` >= TIMESTAMP '0001-01-01 00:00:00+00' OR `at` IS NULL")
    expect(partitionFloor({ kind: "column", column: "at", type: "DATETIME" })).toBe("`at` >= DATETIME '0001-01-01' OR `at` IS NULL")
    expect(partitionFloor({ kind: "range", column: "n" })).toBe("`n` >= -9223372036854775808 OR `n` IS NULL")
    expect(partitionFloor({ kind: "ingestion" })).toBe("_PARTITIONTIME >= TIMESTAMP '0001-01-01 00:00:00+00' OR _PARTITIONTIME IS NULL")
  })

  it("keeps an integer-range table's __UNPARTITIONED__ rows: the floor is INT64's minimum, never the range's start (bigquery-1 LOW 1)", () => {
    // A table partitioned on n from 0, holding only rows below 0 (all in __UNPARTITIONED__): every one passes the floor.
    const floor = /^`n` >= (-?\d+) OR `n` IS NULL$/.exec(partitionFloor({ kind: "range", column: "n" }))
    const minimum = BigInt(floor![1]!)
    expect(minimum).toBe(-(2n ** 63n))
    const unpartitioned = [-1n, -1_000_000n, -(2n ** 63n)]
    expect(unpartitioned.every((value) => value >= minimum)).toBe(true)
  })
})
