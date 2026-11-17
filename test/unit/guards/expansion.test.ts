// Design §14.1 "Expansion" and L13: views and routines to depth 3; depth 4, a permission error or a missing body →
// NEEDS_PLAN; a remote function or a Python UDF reached through a view → NEEDS_PLAN; EXTERNAL_QUERY in a view body or a
// TVF body → NEEDS_PLAN; and the 60 s cache the drift check drops.
import { describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import type { DryRunStatistics, RoutineInfo, TableInfo } from "../../../src/domain/google.js"
import { TtlCache } from "../../../src/guards/cache.js"
import { Expander } from "../../../src/guards/expansion.js"
import { fakePorts } from "../../fake/ports.js"
import { ACCOUNT, DATASET, LOCATION, PROJECT, callsOf, harness, nativeTable, one, routine, runTool, scriptNativeRead, statistics, tableRef } from "../reads/support.js"
import { needsPlan } from "../reads/expect.js"

const path = (name: string) => `${PROJECT}.${DATASET}.${name}`
const refOf = (name: string) => tableRef(name)

function view(name: string, query: string | undefined, overrides: Partial<TableInfo> = {}): TableInfo {
  return nativeTable({ tableReference: refOf(name), type: "VIEW", numBytes: "0", numRows: "0", ...(query !== undefined ? { view: { query } } : { view: {} }), ...overrides })
}

interface World {
  readonly tables: Record<string, TableInfo>
  readonly routines?: Record<string, RoutineInfo>
  /** A view body's dry-run answer, by the body's SQL. */
  readonly bodies?: Record<string, DryRunStatistics | "denied" | "no-statistics">
}

function expander(world: World) {
  const ports = fakePorts()
  const clock = { time: Date.parse("2026-11-17T12:00:00Z") }
  ports.bigquery.on("getTable", async (_account: string, ref: { projectId: string; datasetId: string; tableId: string }) => {
    const found = world.tables[`${ref.projectId}.${ref.datasetId}.${ref.tableId}`]
    if (found) return found
    throw new BigQueryError("NOT_FOUND", "no such table")
  })
  ports.bigquery.on("getRoutine", async (_account: string, ref: { projectId: string; datasetId: string; routineId: string }) => {
    const found = world.routines?.[`${ref.projectId}.${ref.datasetId}.${ref.routineId}`]
    if (found) return found
    throw new BigQueryError("NOT_FOUND", "no such routine")
  })
  ports.bigquery.on("dryRun", async (request: { sql: string }) => {
    const answer = world.bodies?.[request.sql]
    if (answer === "denied") throw new BigQueryError("PERMISSION_DENIED", "a base table the caller cannot read")
    if (answer === "no-statistics") return { location: LOCATION }
    if (answer === undefined) return { location: LOCATION, statistics: { statementType: "SELECT", totalBytesProcessed: "0" } }
    return { location: LOCATION, statistics: answer }
  })
  const tables = new TtlCache<TableInfo>(60_000, () => clock.time)
  const routines = new TtlCache<RoutineInfo>(60_000, () => clock.time)
  const expand = new Expander({ ports, account: ACCOUNT, project: PROJECT, signal: new AbortController().signal, location: LOCATION, tables, routines })
  return { ports, clock, tables, routines, expand }
}

describe("expansion (§5.1 step 4)", () => {
  it("follows views to depth 3 and finds every base table through its body's dry run", async () => {
    const world: World = {
      tables: {
        [path("v1")]: view("v1", `SELECT * FROM \`${path("v2")}\``),
        [path("v2")]: view("v2", `SELECT * FROM \`${path("v3")}\``),
        [path("v3")]: view("v3", `SELECT * FROM \`${path("base")}\``),
        [path("base")]: nativeTable({ tableReference: refOf("base") }),
      },
      bodies: {
        [`SELECT * FROM \`${path("v2")}\``]: { statementType: "SELECT", totalBytesProcessed: "0", referencedLogicalViews: [refOf("v2")] },
        [`SELECT * FROM \`${path("v3")}\``]: { statementType: "SELECT", totalBytesProcessed: "0", referencedLogicalViews: [refOf("v3")] },
        [`SELECT * FROM \`${path("base")}\``]: { statementType: "SELECT", totalBytesProcessed: "10", referencedTables: [refOf("base")] },
      },
    }
    const { expand } = expander(world)
    const result = await expand.expand(statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v1")] }))
    expect(result.unresolved).toEqual([])
    expect(result.views.map((facts) => facts.table)).toEqual(["v1", "v2", "v3"])
    expect(result.tables.map((facts) => facts.table)).toEqual(["base"])
  })

  it("stops at depth 3: a view at depth 4 is unresolved, so the read needs a plan", async () => {
    const world: World = {
      tables: {
        [path("v1")]: view("v1", "SELECT 1"),
        [path("v2")]: view("v2", "SELECT 2"),
        [path("v3")]: view("v3", "SELECT 3"),
        [path("v4")]: view("v4", "SELECT 4"),
      },
      bodies: {
        "SELECT 1": { statementType: "SELECT", referencedLogicalViews: [refOf("v2")] },
        "SELECT 2": { statementType: "SELECT", referencedLogicalViews: [refOf("v3")] },
        "SELECT 3": { statementType: "SELECT", referencedLogicalViews: [refOf("v4")] },
      },
    }
    const { expand } = expander(world)
    const result = await expand.expand(statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v1")] }))
    expect(result.unresolved).toEqual([path("v4")])
  })

  it("an unreadable view, a missing body and a legacy-SQL body are unresolved", async () => {
    const world: World = {
      tables: {
        [path("secret")]: view("secret", "SELECT 1"),
        [path("nobody")]: view("nobody", undefined),
        [path("legacy")]: view("legacy", "SELECT 1", { view: { query: "SELECT 1", useLegacySql: true } }),
        [path("unanalysable")]: view("unanalysable", "SELECT 1"),
      },
      bodies: { "SELECT 1": "denied" },
    }
    const { expand } = expander(world)
    const result = await expand.expand(
      statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("secret"), refOf("nobody"), refOf("legacy"), refOf("unanalysable")] }),
    )
    expect([...result.unresolved].sort()).toEqual([path("legacy"), path("nobody"), path("secret"), path("unanalysable")].sort())
  })

  it("a view body that dry-runs without statistics is unresolved", async () => {
    const world: World = { tables: { [path("v")]: view("v", "SELECT 1") }, bodies: { "SELECT 1": "no-statistics" } }
    const { expand } = expander(world)
    const result = await expand.expand(statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v")] }))
    expect(result.unresolved).toEqual([path("v")])
  })

  it("a signed-out account is not a plan: the auth error comes through", async () => {
    const ports = fakePorts()
    ports.bigquery.on("getTable", async () => {
      throw new BigQueryError("AUTH_REQUIRED", "the sign-in expired")
    })
    const expand = new Expander({ ports, account: ACCOUNT, project: PROJECT, signal: new AbortController().signal, tables: new TtlCache(60_000, Date.now), routines: new TtlCache(60_000, Date.now) })
    await expect(expand.expand(statistics({ referencedTables: [refOf("orders")] }))).rejects.toThrow(/AUTH_REQUIRED/)
  })

  it("a view over a base table another dataset holds puts that base in front of the fence", async () => {
    const h = harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { allow: [`${PROJECT}.${DATASET}`] } } } })
    const base = nativeTable({ tableReference: tableRef("orders", "private") })
    h.bigquery.on("dryRun", async (request: { sql: string; defaultDataset?: unknown }) =>
      request.defaultDataset === undefined
        ? { location: LOCATION, statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [tableRef("v")] }) }
        : { location: LOCATION, statistics: { statementType: "SELECT", totalBytesProcessed: "10", referencedTables: [tableRef("orders", "private")] } },
    )
    h.bigquery.on("getTable", async (_account: string, ref: { datasetId: string; tableId: string }) =>
      ref.tableId === "v" ? view("v", "SELECT * FROM `invented-proj.private.orders`") : base,
    )
    const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.sales.v`" })
    expect(output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(String(output.message)).toContain("`private`")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("a remote function or a Python UDF reached through a view is an external effect, so the read needs a plan (L13)", async () => {
    for (const provider of [
      { routine: routine({ remoteFunctionOptions: { endpoint: "https://invented.invalid/fn" } }), reason: "a remote function" },
      { routine: routine({ language: "PYTHON", definitionBody: "def f(x): return x" }), reason: "a Python UDF" },
    ]) {
      const h = harness()
      h.bigquery.on("dryRun", async (request: { sql: string; defaultDataset?: unknown }) =>
        request.defaultDataset === undefined
          ? { location: LOCATION, statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [tableRef("v")] }) }
          : { location: LOCATION, statistics: { statementType: "SELECT", totalBytesProcessed: "10", referencedRoutines: [{ projectId: PROJECT, datasetId: DATASET, routineId: "fn" }] } },
      )
      h.bigquery.on("getTable", async () => view("v", "SELECT fn(id) FROM `invented-proj.sales.orders`"))
      h.bigquery.on("getRoutine", async () => provider.routine)
      const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.sales.v`" })
      expect(needsPlan(output), provider.reason).toBe("EXTERNAL_EFFECTS")
      expect(String(output.message)).toContain(provider.reason)
      expect(callsOf(h.bigquery, "run")).toEqual([])
    }
  })

  it("a remote function named directly, and a Python UDF named directly, are external effects too (L13)", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { statistics: statistics({ referencedRoutines: [{ projectId: PROJECT, datasetId: DATASET, routineId: "fn" }] }) })
    h.bigquery.on("getRoutine", async () => routine({ remoteFunctionOptions: { endpoint: "https://invented.invalid/fn" } }))
    const { output } = await runTool(h, "query", { sql: "SELECT fn(id) FROM `invented-proj.sales.orders`" })
    expect(needsPlan(output)).toBe("EXTERNAL_EFFECTS")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("EXTERNAL_QUERY and ML calls inside a view or TVF body are external effects", async () => {
    for (const body of ["SELECT * FROM EXTERNAL_QUERY('conn', 'select 1')", "SELECT ML.GENERATE_TEXT(MODEL `p.m`, TABLE t) FROM `invented-proj.sales.orders`"]) {
      const h = harness()
      h.bigquery.on("dryRun", async (request: { sql: string; defaultDataset?: unknown }) =>
        request.defaultDataset === undefined
          ? { location: LOCATION, statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [tableRef("v")] }) }
          : { location: LOCATION, statistics: { statementType: "SELECT", totalBytesProcessed: "10", referencedTables: [refOf("orders")] } },
      )
      h.bigquery.on("getTable", async (_account: string, ref: { tableId: string }) => (ref.tableId === "v" ? view("v", body) : nativeTable()))
      const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.sales.v`" })
      expect(needsPlan(output), body).toBe("EXTERNAL_EFFECTS")
      expect(callsOf(h.bigquery, "run")).toEqual([])
    }
  })

  it("caches a table's answer for 60 s, so two expansions in the window fetch it once", async () => {
    const world: World = { tables: { [path("orders")]: nativeTable() } }
    const { ports, expand, clock } = expander(world)
    const stats = statistics()
    await expand.expand(stats)
    await expand.expand(stats)
    expect(callsOf(ports.bigquery, "getTable")).toHaveLength(1)
    clock.time += 60_001
    await expand.expand(stats)
    expect(callsOf(ports.bigquery, "getTable")).toHaveLength(2)
  })

  it("offers the seen views and routines for the post-run drift comparison", async () => {
    const world: World = {
      tables: { [path("v")]: view("v", "SELECT 1") },
      routines: { [path("fn")]: routine() },
      bodies: { "SELECT 1": { statementType: "SELECT", referencedTables: [refOf("orders")] } },
    }
    const { expand } = expander(world)
    const result = await expand.expand(
      statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v")], referencedRoutines: [{ projectId: PROJECT, datasetId: DATASET, routineId: "fn" }] }),
    )
    expect([...result.seenViews]).toEqual([path("v")])
    expect([...result.seenRoutines]).toEqual([path("fn")])
    expect(one(result.routines).language).toBe("SQL")
  })
})
