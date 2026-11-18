// Design §14.1 "Expansion" and L13: views and routines to depth 3; depth 4, a permission error or a missing body →
// NEEDS_PLAN; a remote function or a Python UDF reached through a view → NEEDS_PLAN; EXTERNAL_QUERY in a view body or a
// TVF body → NEEDS_PLAN; and the 60 s cache the drift check drops.
import { describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import type { DryRunStatistics, RoutineInfo, TableInfo } from "../../../src/domain/google.js"
import { TtlCache } from "../../../src/guards/cache.js"
import { EXPANSION_LIMIT, Expander, MAX_EXPANDED, MAX_LIST, MAX_LOOKUPS } from "../../../src/guards/expansion.js"
import { fakePorts } from "../../fake/ports.js"
import { ACCOUNT, DATASET, LOCATION, PROJECT, callsOf, harness, jobStatus, nativeTable, one, resultPage, routine, runTool, scriptNativeRead, statistics, tableRef } from "../reads/support.js"
import { needsPlan } from "../reads/expect.js"

const path = (name: string) => `${PROJECT}.${DATASET}.${name}`
const refOf = (name: string) => tableRef(name)

function view(name: string, query: string | undefined, overrides: Partial<TableInfo> = {}): TableInfo {
  return nativeTable({ tableReference: refOf(name), type: "VIEW", numBytes: "0", numRows: "0", ...(query !== undefined ? { view: { query } } : { view: {} }), ...overrides })
}

const routineRef = (routineId: string) => ({ projectId: PROJECT, datasetId: DATASET, routineId })

/** A routine and what its body's own dry run names. */
interface Body {
  readonly routine: Partial<RoutineInfo>
  readonly answer?: Partial<DryRunStatistics> | "denied"
}

/**
 * A world where the outer dry run answers `top`, and a routine body's dry run (the one with a default dataset) answers
 * what that routine's entry says: the body is recognised by its own text, so the fake never reads SQL for tables.
 */
function routineWorld(h: ReturnType<typeof harness>, world: { top: DryRunStatistics; routines: Record<string, Body>; tables?: Record<string, TableInfo> }): void {
  h.bigquery.on("dryRun", async (request: { sql: string; defaultDataset?: unknown }) => {
    if (request.defaultDataset === undefined) return { location: LOCATION, statistics: world.top }
    const entry = Object.values(world.routines).find((body) => {
      const text = body.routine.definitionBody
      return text !== undefined && (request.sql.includes(text) || request.sql.includes(text.replace(/\bx\b/g, "(CAST(NULL AS INT64))")))
    })
    if (entry?.answer === "denied") throw new BigQueryError("PERMISSION_DENIED", "a table the caller cannot read")
    return { location: LOCATION, statistics: { statementType: "SELECT", totalBytesProcessed: "0", ...(entry?.answer ?? {}) } }
  })
  h.bigquery.on("getRoutine", async (_account: string, ref: { projectId: string; datasetId: string; routineId: string }) => {
    const entry = world.routines[ref.routineId]
    if (!entry) throw new BigQueryError("NOT_FOUND", "no such routine")
    return routine({ routineReference: ref, language: "SQL", ...entry.routine })
  })
  h.bigquery.on("getTable", async (_account: string, ref: { projectId: string; datasetId: string; tableId: string }) => world.tables?.[`${ref.projectId}.${ref.datasetId}.${ref.tableId}`] ?? nativeTable({ tableReference: ref }))
  h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
  h.bigquery.on("run", async () => jobStatus())
  h.bigquery.on("results", async () => resultPage())
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
    const result = await expand.expand({ statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v1")] }) })
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
    const result = await expand.expand({ statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v1")] }) })
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
    const result = await expand.expand({
      statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("secret"), refOf("nobody"), refOf("legacy"), refOf("unanalysable")] }),
    })
    expect([...result.unresolved].sort()).toEqual([path("legacy"), path("nobody"), path("secret"), path("unanalysable")].sort())
  })

  it("a view body that dry-runs without statistics is unresolved", async () => {
    const world: World = { tables: { [path("v")]: view("v", "SELECT 1") }, bodies: { "SELECT 1": "no-statistics" } }
    const { expand } = expander(world)
    const result = await expand.expand({ statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v")] }) })
    expect(result.unresolved).toEqual([path("v")])
  })

  it("a signed-out account is not a plan: the auth error comes through", async () => {
    const ports = fakePorts()
    ports.bigquery.on("getTable", async () => {
      throw new BigQueryError("AUTH_REQUIRED", "the sign-in expired")
    })
    const expand = new Expander({ ports, account: ACCOUNT, project: PROJECT, signal: new AbortController().signal, tables: new TtlCache(60_000, Date.now), routines: new TtlCache(60_000, Date.now) })
    await expect(expand.expand({ statistics: statistics({ referencedTables: [refOf("orders")] }) })).rejects.toThrow(/AUTH_REQUIRED/)
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

  it("follows a table function's body into the fence through the body's own dry run: a TVF over a fenced table is refused (review H-3)", async () => {
    const h = harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { allow: [`${PROJECT}.sales`] } } } })
    routineWorld(h, {
      top: statistics({ referencedTables: [], referencedRoutines: [routineRef("tvf")] }),
      routines: { tvf: { routine: { routineType: "TABLE_VALUED_FUNCTION", definitionBody: "SELECT * FROM secret_alias_free_text" }, answer: { referencedTables: [tableRef("secret", "private")] } } },
    })
    const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.sales.tvf`()" })
    expect(output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(String(output.message)).toContain("`private`")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("follows a table function's body into the cap: a TVF over a row-secured table cannot be bounded (review H-3)", async () => {
    const h = harness()
    routineWorld(h, {
      top: statistics({ referencedTables: [], referencedRoutines: [routineRef("tvf")] }),
      routines: { tvf: { routine: { routineType: "TABLE_VALUED_FUNCTION", definitionBody: "SELECT * FROM `invented-proj.sales.orders`" }, answer: { referencedTables: [refOf("orders")] } } },
    })
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [{ policyId: "invented" }] }))
    const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.sales.tvf`()" })
    expect(needsPlan(output)).toBe("CAP_NOT_ENFORCEABLE")
    expect(String(output.message)).toContain("row access policy")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("follows a SQL UDF's body to the remote function its own dry run names (review H-3)", async () => {
    const h = harness()
    routineWorld(h, {
      top: statistics({ referencedTables: [refOf("orders")], referencedRoutines: [routineRef("wrapper")] }),
      routines: {
        wrapper: {
          routine: { definitionBody: "`invented-proj.sales.remote_fn`(x)", arguments: [{ name: "x", dataType: { typeKind: "INT64" } }] },
          answer: { referencedRoutines: [routineRef("remote_fn")] },
        },
        remote_fn: { routine: { remoteFunctionOptions: { endpoint: "https://invented.invalid/fn" } } },
      },
    })
    const { output } = await runTool(h, "query", { sql: "SELECT `invented-proj.sales.wrapper`(id) FROM `invented-proj.sales.orders`" })
    expect(needsPlan(output)).toBe("EXTERNAL_EFFECTS")
    expect(String(output.message)).toContain("a remote function")
    // The body went to BigQuery with its argument as a typed NULL and the routine's dataset as the default.
    const probe = callsOf(h.bigquery, "dryRun").map((args) => args[0] as { sql: string; defaultDataset?: unknown; useQueryCache?: boolean }).find((request) => request.defaultDataset !== undefined)!
    expect(probe).toMatchObject({ sql: "SELECT (\n`invented-proj.sales.remote_fn`((CAST(NULL AS INT64)))\n)", defaultDataset: { projectId: PROJECT, datasetId: DATASET }, useQueryCache: false })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("stops a SQL routine chain at depth 3, each level named by its own body's dry run (review H-3)", async () => {
    const h = harness()
    const chain: Record<string, Body> = {}
    for (let level = 1; level <= 4; level += 1) {
      chain[`fn${level}`] = { routine: { definitionBody: `level_${level}(x)` }, answer: { referencedRoutines: level < 4 ? [routineRef(`fn${level + 1}`)] : [] } }
    }
    routineWorld(h, { top: statistics({ referencedTables: [], referencedRoutines: [routineRef("fn1")] }), routines: chain })
    const { output } = await runTool(h, "query", { sql: "SELECT `invented-proj.sales.fn1`(id)" })
    expect(needsPlan(output)).toBe("UNRESOLVED_REFERENCE")
    expect(String(output.message)).toContain("`fn4`")
  })

  it("treats a JavaScript UDF, and a SQL routine with no body, as needing a plan (review H-3)", async () => {
    const scripted = harness()
    scripted.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ referencedTables: [], referencedRoutines: [{ projectId: PROJECT, datasetId: DATASET, routineId: "js" }] }) }))
    scripted.bigquery.on("getRoutine", async (_account: string, ref: never) => routine({ routineReference: ref, language: "JAVASCRIPT", definitionBody: "return x;" }))
    expect(needsPlan((await runTool(scripted, "query", { sql: "SELECT `invented-proj.sales.js`(id)" })).output)).toBe("EXTERNAL_EFFECTS")

    const noBody = harness()
    noBody.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ referencedTables: [], referencedRoutines: [{ projectId: PROJECT, datasetId: DATASET, routineId: "fn" }] }) }))
    noBody.bigquery.on("getRoutine", async (_account: string, ref: never) => routine({ routineReference: ref, language: "SQL" }))
    expect(needsPlan((await runTool(noBody, "query", { sql: "SELECT `invented-proj.sales.fn`(id)" })).output)).toBe("UNRESOLVED_REFERENCE")
  })

  it("treats a view body's dry run without a statement type as unresolved (review LOW 2)", async () => {
    const world: World = { tables: { [path("v")]: view("v", "SELECT 1") }, bodies: { "SELECT 1": { totalBytesProcessed: "10" } as DryRunStatistics } }
    const { expand } = expander(world)
    const result = await expand.expand({ statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v")] }) })
    expect(result.unresolved).toEqual([path("v")])
  })

  it("caches a table's answer for 60 s, so two expansions in the window fetch it once", async () => {
    const world: World = { tables: { [path("orders")]: nativeTable() } }
    const { ports, expand, clock } = expander(world)
    const stats = statistics()
    await expand.expand({ statistics: stats })
    await expand.expand({ statistics: stats })
    expect(callsOf(ports.bigquery, "getTable")).toHaveLength(1)
    clock.time += 60_001
    await expand.expand({ statistics: stats })
    expect(callsOf(ports.bigquery, "getTable")).toHaveLength(2)
  })

  it("offers the seen views and routines for the post-run drift comparison", async () => {
    const world: World = {
      tables: { [path("v")]: view("v", "SELECT 1") },
      routines: { [path("fn")]: routine() },
      bodies: { "SELECT 1": { statementType: "SELECT", referencedTables: [refOf("orders")] } },
    }
    const { expand } = expander(world)
    const result = await expand.expand({
      statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v")], referencedRoutines: [{ projectId: PROJECT, datasetId: DATASET, routineId: "fn" }] }),
    })
    expect([...result.seenViews]).toEqual([path("v")])
    expect([...result.seenRoutines]).toEqual([path("fn")])
    expect(one(result.routines).language).toBe("SQL")
  })
})

describe("expansion is bounded (review bigquery-3 round 3, LOWs 1, 2 and 6)", () => {
  const views = (count: number, body: (index: number) => string) => {
    const tables: Record<string, TableInfo> = {}
    for (let index = 0; index < count; index += 1) tables[path(`v${index}`)] = view(`v${index}`, body(index))
    return tables
  }

  it(`expands at most ${MAX_EXPANDED} views and routines, then stops asking and is unresolved`, async () => {
    const count = MAX_EXPANDED + 8
    const world: World = { tables: views(count, (index) => `SELECT ${index}`) }
    const { expand, ports } = expander(world)
    const result = await expand.expand({ statistics: statistics({ referencedTables: undefined, referencedLogicalViews: Array.from({ length: count }, (_, index) => refOf(`v${index}`)) }) })
    expect(result.unresolved).toContain(EXPANSION_LIMIT)
    expect(result.limit).toContain(`more than ${MAX_EXPANDED} views and routines`)
    expect(callsOf(ports.bigquery, "dryRun").length).toBeLessThanOrEqual(MAX_EXPANDED)
    expect(callsOf(ports.bigquery, "getTable").length).toBeLessThanOrEqual(MAX_EXPANDED + 1)
  })

  it("bounds a fan-out of views over views, however wide each level is", async () => {
    // v_root → 40 views, each → 40 more: without a bound, 1,641 lookups and dry runs.
    const tables: Record<string, TableInfo> = { [path("root")]: view("root", "SELECT root") }
    const bodies: Record<string, DryRunStatistics> = { "SELECT root": { statementType: "SELECT", referencedLogicalViews: Array.from({ length: 40 }, (_, index) => refOf(`a${index}`)) } }
    for (let a = 0; a < 40; a += 1) {
      tables[path(`a${a}`)] = view(`a${a}`, `SELECT a${a}`)
      bodies[`SELECT a${a}`] = { statementType: "SELECT", referencedLogicalViews: Array.from({ length: 40 }, (_, index) => refOf(`b${a}_${index}`)) }
      for (let b = 0; b < 40; b += 1) tables[path(`b${a}_${b}`)] = view(`b${a}_${b}`, "SELECT 1")
    }
    const { expand, ports } = expander({ tables, bodies })
    const result = await expand.expand({ statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("root")] }) })
    expect(result.unresolved).toContain(EXPANSION_LIMIT)
    expect(callsOf(ports.bigquery, "dryRun").length).toBeLessThanOrEqual(MAX_EXPANDED)
  })

  it(`reads at most ${MAX_LOOKUPS} objects' metadata, even when each body names fewer than ${MAX_LIST} tables`, async () => {
    const tables: Record<string, TableInfo> = {}
    const bodies: Record<string, DryRunStatistics> = {}
    for (let v = 0; v < 10; v += 1) {
      tables[path(`v${v}`)] = view(`v${v}`, `SELECT v${v}`)
      bodies[`SELECT v${v}`] = { statementType: "SELECT", referencedTables: Array.from({ length: MAX_LIST - 1 }, (_, index) => refOf(`t${v}_${index}`)) }
      for (let t = 0; t < MAX_LIST - 1; t += 1) tables[path(`t${v}_${t}`)] = nativeTable({ tableReference: refOf(`t${v}_${t}`) })
    }
    const { expand, ports } = expander({ tables, bodies })
    const result = await expand.expand({ statistics: statistics({ referencedTables: undefined, referencedLogicalViews: Array.from({ length: 10 }, (_, index) => refOf(`v${index}`)) }) })
    expect(result.limit).toContain(`more than ${MAX_LOOKUPS}`)
    expect(callsOf(ports.bigquery, "getTable").length).toBeLessThanOrEqual(MAX_LOOKUPS)
  })

  it(`takes a referenced list of ${MAX_LIST} or more as possibly cut, at the top and in a body; ${MAX_LIST - 1} is complete`, async () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => refOf(`t${index}`))
    const tables: Record<string, TableInfo> = {}
    for (let index = 0; index < MAX_LIST; index += 1) tables[path(`t${index}`)] = nativeTable({ tableReference: refOf(`t${index}`) })

    const top = await expander({ tables }).expand.expand({ statistics: statistics({ referencedTables: many(MAX_LIST) }) })
    expect(top.unresolved).toEqual([EXPANSION_LIMIT])
    expect(top.limit).toContain(`${MAX_LIST} or more`)

    const fine = await expander({ tables }).expand.expand({ statistics: statistics({ referencedTables: many(MAX_LIST - 1) }) })
    expect(fine.unresolved).toEqual([])

    const inBody = await expander({ tables: { ...tables, [path("v")]: view("v", "SELECT v") }, bodies: { "SELECT v": { statementType: "SELECT", referencedTables: many(MAX_LIST) } } }).expand.expand({
      statistics: statistics({ referencedTables: undefined, referencedLogicalViews: [refOf("v")] }),
    })
    expect(inBody.unresolved).toContain(EXPANSION_LIMIT)
  })

  it("answers a read past a limit with NEEDS_PLAN, naming the limit, and runs nothing", async () => {
    const h = harness()
    const count = MAX_EXPANDED + 1
    h.bigquery.on("dryRun", async (request: { defaultDataset?: unknown }) =>
      request.defaultDataset === undefined
        ? { location: LOCATION, statistics: statistics({ referencedTables: [], referencedLogicalViews: Array.from({ length: count }, (_, index) => refOf(`v${index}`)) }) }
        : { location: LOCATION, statistics: { statementType: "SELECT", totalBytesProcessed: "0" } },
    )
    h.bigquery.on("getTable", async (_account: string, ref: { tableId: string }) => view(ref.tableId, "SELECT 1"))
    const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.sales.v0`" })
    expect(needsPlan(output)).toBe("UNRESOLVED_REFERENCE")
    expect(String(output.message)).toContain(`at most ${MAX_EXPANDED} views and routines`)
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("fences the dry run's own lists before reading anything they name (LOW 6)", async () => {
    const h = harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { allow: [`${PROJECT}.${DATASET}`] } } } })
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ referencedTables: [], referencedLogicalViews: [tableRef("v", "private")], referencedRoutines: [{ projectId: PROJECT, datasetId: "private", routineId: "fn" }] }) }))
    const { output } = await runTool(h, "query", { sql: "SELECT * FROM `invented-proj.private.v`" })
    expect(output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(callsOf(h.bigquery, "getTable")).toEqual([])
    expect(callsOf(h.bigquery, "getRoutine")).toEqual([])
    expect(callsOf(h.bigquery, "dryRun")).toHaveLength(1)
  })
})
