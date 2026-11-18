// Design §14.1 "Classification" and "Plans" over `bigquery_plan`: the statement type and the lexer pick the category,
// a plain read is refused, a read the cap cannot bound becomes an uncapped-read plan, a read with effects or unresolved
// references becomes a write plan, scripts have their own requirements, admin plans need a reason, the dry run's DDL and
// DML fields (not a parse of the SQL) name the targets, and the fence covers them.
import { describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import {
  LOCATION,
  PROJECT,
  callsOf,
  harness,
  jobStatus,
  nativeTable,
  one,
  readOnly,
  runTool,
  scriptChange,
  signedIn,
  statistics,
  tableRef,
} from "./support.js"

const INSERT_SQL = "INSERT INTO `invented-proj.sales.orders` (id) SELECT id FROM `invented-proj.sales.other`"

/** A plan over one native table: the dry run answers once, the table is native and has no row policy. */
function planHarness(input: Parameters<typeof scriptChange>[1], account = readOnly(), extra: Record<string, unknown> = {}) {
  const h = harness(account, extra)
  scriptChange(h.bigquery, input)
  return h
}

describe("bigquery_plan: the classification of design §5.2", () => {
  it("classifies every category from the dry run's statement type", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["INSERT", {}, "write"],
      ["UPDATE", {}, "write"],
      ["CREATE_TABLE", {}, "write"],
      ["ALTER_TABLE", {}, "write"],
      ["LOAD_DATA", {}, "write"],
      ["EXPORT_DATA", {}, "export"],
      ["GRANT_ON_TABLE", {}, "share"],
      ["CREATE_ROW_ACCESS_POLICY", {}, "share"],
      ["DELETE", {}, "delete"],
      ["DROP_TABLE", {}, "delete"],
      ["SCRIPT", { maxBytes: "1GiB" }, "delete"],
      ["CALL", {}, "delete"],
      ["CREATE_CAPACITY", { reason: "reserve capacity for the nightly load" }, "admin"],
    ]
    for (const [statementType, input, category] of cases) {
      const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType, referencedTables: statementType === "CREATE_CAPACITY" ? [] : [tableRef()], totalBytesProcessed: "1024" }) }] })
      const { output } = await runTool(h, "plan", { sql: "SELECT 1", ...input })
      expect(output, statementType).toMatchObject({ state: "done", category })
      expect(output.commitWith, statementType).toContain(category === "uncapped-read" ? "bigquery_query" : `bigquery_${category}`)
      expect(h.ports.plans.list(), statementType).toHaveLength(1)
    }
  })

  it("lets the lexer raise a category, never lower it (M4, stricter-wins)", async () => {
    const cases: [string, string][] = [
      ["CREATE_TABLE", "CREATE OR REPLACE TABLE `invented-proj.sales.orders` (id INT64)"],
      ["MERGE", "MERGE `invented-proj.sales.orders` t USING `invented-proj.sales.other` s ON t.id = s.id WHEN MATCHED THEN DELETE"],
      ["ALTER_TABLE", "ALTER TABLE `invented-proj.sales.orders` DROP COLUMN amount"],
      ["ALTER_TABLE", "ALTER TABLE `invented-proj.sales.orders` SET OPTIONS (expiration_timestamp = TIMESTAMP '2027-01-01')"],
      ["LOAD_DATA", "LOAD DATA OVERWRITE `invented-proj.sales.orders` FROM FILES (format = 'CSV', uris = ['gs://invented/x.csv'])"],
    ]
    for (const [statementType, sql] of cases) {
      const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType, referencedTables: [tableRef()], totalBytesProcessed: "0" }) }] })
      const { output } = await runTool(h, "plan", { sql })
      expect(output.error, sql).toBeUndefined()
      expect(output.category, sql).toBe("delete")
    }
  })

  it("refuses a plain SELECT with CATEGORY_MISMATCH and creates no plan", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "SELECT", totalBytesProcessed: "1024" }) }] })
    const { output } = await runTool(h, "plan", { sql: "SELECT id FROM `invented-proj.sales.orders`" })
    expect(output).toMatchObject({ state: "refused", error: "CATEGORY_MISMATCH" })
    expect(String(output.next)).toContain("bigquery_query")
    expect(h.ports.plans.list()).toEqual([])
  })

  it("makes a SELECT the cap cannot bound an uncapped-read plan, committable on a Read account", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "SELECT", totalBytesProcessedAccuracy: "LOWER_BOUND", totalBytesProcessed: "2048" }) }] })
    const { output } = await runTool(h, "plan", { sql: "SELECT id FROM `invented-proj.sales.orders`" })
    expect(output).toMatchObject({ state: "done", category: "uncapped-read", committable: true, commitWith: "bigquery_query({ planId })" })
    const preview = output.preview as Record<string, unknown>
    expect(String(preview.bound)).toContain("The cap may not bound this query: the estimate is a lower bound")
    expect(String(preview.bound)).toContain("120 seconds")
    const plan = one(h.ports.plans.list())
    expect(plan.statement.jobTimeoutSeconds).toBe(120)
    expect(plan.statement.capEnforceable).toBe(false)
  })

  it("answers CAP_NOT_ENFORCEABLE for that read when uncappedReads is refuse", async () => {
    const h = planHarness(
      { dryRuns: [{ statistics: statistics({ statementType: "SELECT", totalBytesProcessedAccuracy: "LOWER_BOUND", totalBytesProcessed: "2048" }) }] },
      readOnly(),
      { uncappedReads: "refuse" },
    )
    const { output } = await runTool(h, "plan", { sql: "SELECT id FROM `invented-proj.sales.orders`" })
    expect(output).toMatchObject({ state: "refused", error: "CAP_NOT_ENFORCEABLE" })
    expect(h.ports.plans.list()).toEqual([])
  })

  it("sends a read with external effects to a write plan, not an uncapped read", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "SELECT", totalBytesProcessed: "1024" }) }] })
    const { output } = await runTool(h, "plan", { sql: "SELECT ML.GENERATE_TEXT(MODEL `invented-proj.ml.m`, (SELECT id FROM `invented-proj.sales.orders`))" })
    expect(output).toMatchObject({ state: "done", category: "write", committable: false })
    const preview = output.preview as Record<string, unknown>
    expect(preview.bound).toBe("Billed outside the byte cap: AI/ML (Vertex).")
  })

  it("sends a read with unresolved references to a write plan", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "SELECT", referencedTables: [], totalBytesProcessed: "0" }) }] })
    const { output } = await runTool(h, "plan", { sql: "CREATE TEMP FUNCTION f() AS (1); SELECT f()" })
    expect(output).toMatchObject({ state: "done", category: "write", committable: false })
    expect(String((output.preview as Record<string, unknown>).bound)).toContain("could not be resolved")
  })

  it("refuses an unknown statement type and a legacy query before planning", async () => {
    for (const [sql, stats, error] of [
      ["SELECT 1", statistics({ statementType: "FROBNICATE" }), "STATEMENT_UNKNOWN"],
      ["#legacySQL\nSELECT 1", statistics({ statementType: "SELECT" }), "LEGACY_SQL_REFUSED"],
    ] as const) {
      const h = planHarness({ dryRuns: [{ statistics: stats }] })
      const { output } = await runTool(h, "plan", { sql })
      expect(output, sql).toMatchObject({ state: "refused", error })
      expect(h.ports.plans.list(), sql).toEqual([])
    }
  })
})

describe("bigquery_plan: the targets are the dry run's, never the SQL text's", () => {
  it("names a DDL target from ddlTargetTable, not from the name in the SQL", async () => {
    const h = planHarness({
      dryRuns: [
        {
          statistics: statistics({
            statementType: "CREATE_TABLE",
            totalBytesProcessed: "0",
            referencedTables: [],
            ddlTargetTable: tableRef("actual_target"),
            ddlOperationPerformed: "CREATE",
          }),
        },
      ],
    })
    const { output } = await runTool(h, "plan", { sql: "CREATE TABLE `invented-proj.sales.from_text` (id INT64)" })
    const targets = (output.preview as { targets: string[] }).targets
    expect(targets).toEqual(["invented-proj.sales.actual_target"])
    expect(h.ports.plans.list()[0]!.statement.targets).toEqual(targets)
  })

  it("names a DML's affected tables from the dry run's referencedTables", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "INSERT", referencedTables: [tableRef(), tableRef("other")] }) }] })
    const { output } = await runTool(h, "plan", { sql: INSERT_SQL })
    expect((output.preview as { targets: string[] }).targets.sort()).toEqual(["invented-proj.sales.orders", "invented-proj.sales.other"])
  })

  it("names a dataset, a routine and a row access policy target", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["CREATE_SCHEMA", { ddlTargetDataset: { projectId: PROJECT, datasetId: "fresh" }, referencedTables: [] }, "invented-proj.fresh"],
      ["CREATE_FUNCTION", { ddlTargetRoutine: { projectId: PROJECT, datasetId: "sales", routineId: "fn" }, referencedTables: [] }, "invented-proj.sales.fn"],
      [
        "CREATE_ROW_ACCESS_POLICY",
        { ddlTargetRowAccessPolicy: { projectId: PROJECT, datasetId: "sales", tableId: "orders", policyId: "p1" }, referencedTables: [] },
        "invented-proj.sales.orders (policy p1)",
      ],
    ]
    for (const [statementType, fields, target] of cases) {
      const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType, totalBytesProcessed: "0", ...fields }) }] })
      const { output } = await runTool(h, "plan", { sql: "SELECT 1" })
      expect(output.category, statementType).toBe(statementType === "CREATE_SCHEMA" || statementType === "CREATE_FUNCTION" ? "write" : "share")
      expect((output.preview as { targets: string[] }).targets, statementType).toContain(target)
    }
  })

  it("refuses a DDL target outside the account's dataset fence", async () => {
    const accounts = { default: { billingProject: PROJECT, location: LOCATION, datasets: { deny: ["invented-proj.hr"] } } }
    const h = planHarness(
      { dryRuns: [{ statistics: statistics({ statementType: "CREATE_TABLE", totalBytesProcessed: "0", referencedTables: [], ddlTargetTable: tableRef("people", "hr") }) }] },
      readOnly(),
      { accounts },
    )
    const { output } = await runTool(h, "plan", { sql: "CREATE TABLE `invented-proj.hr.people` (id INT64)" })
    expect(output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(h.ports.plans.list()).toEqual([])
  })
})

describe("bigquery_plan: scripts and admin", () => {
  it("requires maxBytes for a script and refuses one when scripts are off", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "SCRIPT", referencedTables: [], totalBytesProcessed: "0" }) }] })
    const missing = await runTool(h, "plan", { sql: "SELECT 1; SELECT 2" })
    expect(missing.output).toMatchObject({ state: "refused", error: "SCRIPT_CAP_REQUIRED" })

    const off = planHarness(
      { dryRuns: [{ statistics: statistics({ statementType: "SCRIPT", referencedTables: [], totalBytesProcessed: "0" }) }] },
      readOnly(),
      { scripts: false },
    )
    const refused = await runTool(off, "plan", { sql: "SELECT 1; SELECT 2", maxBytes: "1GiB" })
    expect(refused.output).toMatchObject({ state: "refused", error: "SCRIPT_REFUSED" })
  })

  it("previews a script's bound and carries 300 s, or a lower time limit", async () => {
    for (const [passed, expected] of [
      [undefined, 300],
      [120, 120],
      [900, 300],
    ] as const) {
      const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "SCRIPT", referencedTables: [], totalBytesProcessed: "0" }) }] })
      const { output } = await runTool(h, "plan", { sql: "SELECT 1; SELECT 2", maxBytes: "1GiB", ...(passed !== undefined ? { jobTimeoutSeconds: passed } : {}) })
      expect(output.category, String(passed)).toBe("delete")
      expect(String((output.preview as Record<string, unknown>).bound), String(passed)).toContain("A script: the estimate covers only the statements before the first `CALL`")
      expect(one(h.ports.plans.list()).statement.jobTimeoutSeconds, String(passed)).toBe(expected)
      expect(one(h.ports.plans.list()).statement.capEnforceable, String(passed)).toBe(false)
    }
  })

  it("names CREATE TEMP TABLE's dry-run failure SCRIPT_NOT_DRY_RUNNABLE, and another error SQL_INVALID", async () => {
    // The fake throws what package B raises for Google's invalidQuery (the dry run failed), and the lexer's wording
    // check names Google's documented CREATE TEMP TABLE limitation.
    const temp = planHarness({ dryRuns: [{ error: new BigQueryError("SQL_INVALID", "Syntax error near CREATE TEMP TABLE") }] })
    const { output } = await runTool(temp, "plan", { sql: "CREATE TEMP TABLE t (x INT64); SELECT * FROM t", maxBytes: "1GiB" })
    expect(output).toMatchObject({ state: "refused", error: "SCRIPT_NOT_DRY_RUNNABLE" })

    const other = planHarness({ dryRuns: [{ error: new BigQueryError("SQL_INVALID", "Syntax error") }] })
    const bad = await runTool(other, "plan", { sql: "SELECT 1; SELEC 2", maxBytes: "1GiB" })
    expect(bad.output).toMatchObject({ state: "refused", error: "SQL_INVALID" })
  })

  it("requires a reason for an admin plan when the option says so, and shows it", async () => {
    const stats = statistics({ statementType: "CREATE_CAPACITY", referencedTables: [], totalBytesProcessed: "0" })
    const missing = planHarness({ dryRuns: [{ statistics: stats }] })
    expect((await runTool(missing, "plan", { sql: "CREATE CAPACITY ..." })).output).toMatchObject({ state: "refused", error: "ADMIN_REASON_REQUIRED" })

    const h = planHarness({ dryRuns: [{ statistics: stats }] })
    const { output } = await runTool(h, "plan", { sql: "CREATE CAPACITY ...", reason: "reserve slots for the nightly load" })
    expect(output).toMatchObject({ state: "done", category: "admin", committable: false })
    expect((output.preview as Record<string, unknown>).reason).toBe("reserve slots for the nightly load")
    expect(String((output.preview as Record<string, unknown>).bound)).toContain("reserve slots for the nightly load")
  })

  it("refuses admin plans when the admin option is off", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ statementType: "CREATE_CAPACITY", referencedTables: [], totalBytesProcessed: "0" }) }] }, readOnly(), {
      admin: { enabled: false, requireReason: true },
    })
    const { output } = await runTool(h, "plan", { sql: "CREATE CAPACITY ...", reason: "why" })
    expect(output).toMatchObject({ state: "refused", error: "PERMISSION_DENIED" })
    expect(h.ports.plans.list()).toEqual([])
  })
})

describe("bigquery_plan: the preview's numbers and the cap", () => {
  it("shows the estimate, accuracy, USD, cap and the bound sentence", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics({ totalBytesProcessed: String(2 ** 30) }) }] })
    const { output } = await runTool(h, "plan", { sql: INSERT_SQL })
    const preview = output.preview as Record<string, unknown>
    expect(preview).toMatchObject({ bytes: 2 ** 30, accuracy: "PRECISE", capBytes: 10 * 2 ** 30 })
    expect(String(preview.bound)).toContain("The cap bounds this statement.")
    expect(String(preview.bound)).toContain("names the tables a DML statement references, not which one it writes")
    expect(preview.usd).toBeCloseTo((2 ** 30 / 2 ** 40) * 6.25, 8)
    expect(preview.referenced).toEqual([
      expect.objectContaining({ kind: "table", name: "invented-proj.sales.orders", storage: "native", tagged: [] }),
    ])
    expect(String(output.expiresAt)).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it("refuses an estimate over the cap (COST_CAP) and a maxBytes above the ceiling", async () => {
    const over = planHarness({ dryRuns: [{ statistics: statistics({ totalBytesProcessed: String(20 * 2 ** 30) }) }] })
    expect((await runTool(over, "plan", { sql: INSERT_SQL })).output).toMatchObject({ state: "refused", error: "COST_CAP" })

    const ceiling = planHarness({ dryRuns: [{ statistics: statistics() }] })
    expect((await runTool(ceiling, "plan", { sql: INSERT_SQL, maxBytes: "200GiB" })).output).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
  })

  it("states each native table's row-access verdict in the preview", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics() }] })
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [{ policyId: "p1" }] }))
    const { output } = await runTool(h, "plan", { sql: INSERT_SQL })
    const preview = output.preview as { referenced: Record<string, unknown>[]; bound: string }
    expect(preview.referenced[0]).toMatchObject({ kind: "table", name: "invented-proj.sales.orders", rowSecured: true })
    expect(preview.bound).toContain("has a row access policy")
  })

  it("keeps a tagged table's columns out of the referenced record's inline claim, and names them", async () => {
    const h = planHarness({ dryRuns: [{ statistics: statistics() }], tables: { "invented-proj.sales.orders": nativeTable({ schema: { fields: [{ name: "id", type: "INT64" }, { name: "ssn", type: "STRING", policyTags: { names: ["x"] } }] } }) } })
    const { output } = await runTool(h, "plan", { sql: INSERT_SQL })
    expect((output.preview as { referenced: Record<string, unknown>[] }).referenced[0]).toMatchObject({ tagged: ["ssn"] })
  })
})
