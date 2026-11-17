// Design §14.1 "Fence" and §5.4: all four referenced lists and the expanded bases, deny wins, wildcards, fail closed —
// and the adversarial SQL that tries to hide an object from a text-based check, which the fence never uses.
import { describe, expect, it } from "vitest"
import { assertFenced, isFenced, matchesPattern } from "../../../src/guards/fence.js"
import { BigQueryError } from "../../../src/domain/errors.js"
import { LOCATION, PROJECT, DATASET, callsOf, harness, nativeTable, runTool, scriptNativeRead, statistics, tableRef } from "../reads/support.js"

const fenced = (allow?: readonly string[], deny?: readonly string[]) => ({ allow, deny })
const object = (dataset = "sales", project = PROJECT, name = "orders", kind = "table") => ({ project, dataset, name, kind })

describe("the fence's patterns and rules (§5.4)", () => {
  it("matches project.dataset, with * across either part", () => {
    expect(matchesPattern(`${PROJECT}.sales`, PROJECT, "sales")).toBe(true)
    expect(matchesPattern(`${PROJECT}.*`, PROJECT, "anything")).toBe(true)
    expect(matchesPattern("*.sales_*", "other", "sales_2026")).toBe(true)
    expect(matchesPattern("*.sales_*", "other", "salesXXXX")).toBe(false)
    expect(matchesPattern(`${PROJECT}.sales`, PROJECT, "sales_2026")).toBe(false)
  })

  it("allows everything with no fence, and only a match when allow is set", () => {
    expect(isFenced(undefined, object())).toBe(false)
    expect(isFenced(fenced([`${PROJECT}.sales`]), object())).toBe(false)
    expect(isFenced(fenced([`${PROJECT}.other`]), object())).toBe(true)
    // A fence that allows nothing allows nothing.
    expect(isFenced(fenced([]), object())).toBe(true)
    // A deny list alone fences only its matches.
    expect(isFenced(fenced(undefined, [`*.private`]), object())).toBe(false)
    expect(isFenced(fenced(undefined, [`*.sales`]), object())).toBe(true)
  })

  it("lets deny win over allow", () => {
    expect(isFenced(fenced([`${PROJECT}.*`], [`${PROJECT}.sales`]), object())).toBe(true)
  })

  it("names the object with validated identifiers in its refusal", () => {
    let error: unknown
    try {
      assertFenced(fenced([`${PROJECT}.other`]), [object("sa`les", PROJECT, "or ders")])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(BigQueryError)
    expect((error as BigQueryError).code).toBe("DATASET_FENCED")
    expect((error as BigQueryError).detail).toContain("`object`")
    expect((error as BigQueryError).detail).not.toContain("or ders")
  })
})

/** A harness whose one dataset is allowed, so any other object is fenced. */
const fencedHarness = (deny: readonly string[] = []) => harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { allow: [`${PROJECT}.${DATASET}`], deny } } } })

describe("the fence over the dry run's four lists and expansion (§5.4)", () => {
  it("refuses a table outside the fence before any run", async () => {
    const h = fencedHarness()
    scriptNativeRead(h.bigquery, { statistics: statistics({ referencedTables: [tableRef("orders", "private")] }) })
    const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.private.orders`" })
    expect(output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(String(output.message)).toContain("`private`")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("refuses a logical view, a routine and a property graph outside the fence", async () => {
    const cases = [
      statistics({ referencedTables: undefined, referencedLogicalViews: [tableRef("v", "private")] }),
      statistics({ referencedTables: undefined, referencedRoutines: [{ projectId: PROJECT, datasetId: "private", routineId: "fn" }] }),
      statistics({ referencedTables: undefined, referencedPropertyGraphs: [{ projectId: PROJECT, datasetId: "private", propertyGraphId: "g" }] }),
    ]
    for (const stats of cases) {
      const h = fencedHarness()
      h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: stats }))
      h.bigquery.on("getTable", async () => nativeTable({ type: "VIEW", view: { query: "SELECT 1" } }))
      h.bigquery.on("getRoutine", async () => ({ routineReference: { projectId: PROJECT, datasetId: "private", routineId: "fn" }, language: "SQL", definitionBody: "SELECT 1" }))
      const { output } = await runTool(h, "query", { sql: "SELECT 1" })
      expect(output.error, JSON.stringify(stats)).toBe("DATASET_FENCED")
      expect(callsOf(h.bigquery, "run")).toEqual([])
    }
  })

  it("fences a table's sample, which reads rows, before tabledata.list", async () => {
    const h = fencedHarness()
    h.bigquery.on("getTable", async () => nativeTable({ tableReference: tableRef("orders", "private") }))
    const { output } = await runTool(h, "table", { project: PROJECT, dataset: "private", table: "orders", sample: 5 })
    expect(output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(callsOf(h.bigquery, "listTableData")).toEqual([])
  })

  it("lets deny win when everything would otherwise be allowed", async () => {
    const h = fencedHarness([`${PROJECT}.sales`])
    scriptNativeRead(h.bigquery)
    const { output } = await runTool(h, "query", { sql: "SELECT id FROM `invented-proj.sales.orders`" })
    expect(output).toMatchObject({ error: "DATASET_FENCED" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })
})

describe("adversarial SQL cannot hide an object from the fence", () => {
  it("does not fence a table named only in a comment or a string, because Google references no object", async () => {
    for (const sql of [
      "SELECT 1 -- FROM `invented-proj.private.orders`",
      "SELECT '`invented-proj.private.orders`' AS mentioned",
      "SELECT 1 /* CALL p(); DELETE FROM private.orders */",
    ]) {
      const h = fencedHarness()
      scriptNativeRead(h.bigquery, { statistics: statistics({ referencedTables: [] }) })
      const { output } = await runTool(h, "query", { sql })
      expect(output, sql).toMatchObject({ state: "done" })
    }
  })

  it("is not fooled by a CTE that shadows a fenced table's name", async () => {
    const shadowed = "WITH private AS (SELECT 1 AS id) SELECT id FROM private"
    const h = fencedHarness()
    scriptNativeRead(h.bigquery, { statistics: statistics({ referencedTables: [] }) })
    expect((await runTool(h, "query", { sql: shadowed })).output).toMatchObject({ state: "done" })

    const real = fencedHarness()
    scriptNativeRead(real.bigquery, { statistics: statistics({ referencedTables: [tableRef("orders", "private")] }) })
    expect((await runTool(real, "query", { sql: shadowed })).output).toMatchObject({ error: "DATASET_FENCED" })
  })

  it("refuses CALL, EXECUTE IMMEDIATE and a multi-statement script as changes, whatever they name", async () => {
    for (const [sql, type] of [
      ["CALL `invented-proj.private`.do_things()", "CALL"],
      ["EXECUTE IMMEDIATE 'SELECT * FROM `invented-proj.private.orders`'", "SCRIPT"],
      ["SELECT 1; SELECT * FROM `invented-proj.private.orders`", "SCRIPT"],
    ] as const) {
      const h = fencedHarness()
      h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: { ...statistics(), statementType: type, referencedTables: [] } }))
      const { output } = await runTool(h, "query", { sql })
      expect(output, sql).toMatchObject({ state: "refused", error: "STATEMENT_NOT_READ" })
      expect(callsOf(h.bigquery, "run")).toEqual([])
    }
  })

  it("follows a view body's backquoted path into the fence", async () => {
    const h = fencedHarness()
    h.bigquery.on("dryRun", async (request: { defaultDataset?: unknown }) =>
      request.defaultDataset === undefined
        ? { location: LOCATION, statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [tableRef("v")] }) }
        : { location: LOCATION, statistics: { statementType: "SELECT", referencedTables: [tableRef("orders", "private")] } },
    )
    h.bigquery.on("getTable", async (_account: string, ref: { projectId: string; datasetId: string; tableId: string }) => (ref.tableId === "v" ? nativeTable({ type: "VIEW", view: { query: "SELECT * FROM `invented-proj.private.orders`" } }) : nativeTable({ tableReference: ref })))
    const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.sales.v`" })
    expect(output).toMatchObject({ error: "DATASET_FENCED" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })
})
