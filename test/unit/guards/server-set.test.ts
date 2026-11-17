// Review bigquery-3, both rounds: every probe the reviewer ran against the alias-resolving lexer, now answered by the
// server set. The fake below plays Google's dry run: for each text it answers the referenced lists BigQuery would
// compute (that is the fixture), and the guards are tested on what they do with those lists. Nothing in this file lets
// the plugin's own reading of a FROM clause decide a table, so a syntax the lexer never saw cannot change an answer.
import { describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import type { DryRunStatistics, RoutineInfo, RoutineReference, SchemaField, TableInfo, TableReference } from "../../../src/domain/google.js"
import { isInformationSchema } from "../../../src/guards/expansion.js"
import { prepareRead, readContext } from "../../../src/guards/read.js"
import { needsPlan } from "../reads/expect.js"
import { DATASET, LOCATION, PROJECT, call, callsOf, harness, jobStatus, nativeTable, resultPage, routine, runTool, statistics, tableRef, type Harness } from "../reads/support.js"

const TAG = { names: ["projects/p/locations/us/taxonomies/1/policyTags/2"] }
const key = (ref: TableReference) => `${ref.projectId}.${ref.datasetId}.${ref.tableId}`
const rref = (routineId: string, datasetId = DATASET): RoutineReference => ({ projectId: PROJECT, datasetId, routineId })

/** `ds.customers` holds a tagged `ssn`; `ds.orders` and the others hold nothing tagged. */
const customers = tableRef("customers", "ds")
const orders = tableRef("orders", "ds")
const secret = tableRef("secret", "fenced")
const fields = (tagged: boolean): SchemaField[] => [{ name: "id", type: "INT64" }, { name: "ssn", type: "STRING", ...(tagged ? { policyTags: TAG } : {}) }]

interface Google {
  /** What BigQuery's dry run names for an exact text (the outer query or a body). */
  readonly answers: Record<string, Partial<DryRunStatistics> | "invalid">
  readonly tables?: Record<string, TableInfo>
  readonly routines?: Record<string, Partial<RoutineInfo>>
}

/** A harness whose dry run answers like Google from `google.answers`, and whose metadata comes from `google`. */
function world(google: Google, extra: Record<string, unknown> = {}): Harness {
  const h = harness(undefined, extra)
  const tables: Record<string, TableInfo> = {
    [key(customers)]: nativeTable({ tableReference: customers, schema: { fields: fields(true) } }),
    [key(orders)]: nativeTable({ tableReference: orders, schema: { fields: fields(false) } }),
    [key(secret)]: nativeTable({ tableReference: secret, schema: { fields: fields(false) } }),
    [key(tableRef())]: nativeTable(),
    ...google.tables,
  }
  h.bigquery.on("dryRun", async (request: { sql: string }) => {
    const answer = google.answers[request.sql]
    if (answer === "invalid") throw new BigQueryError("SQL_INVALID", "BigQuery refused the text", undefined, { googleError: { message: "Table name missing dataset", trust: "untrusted" } })
    if (answer === undefined) throw new Error(`the fake Google has no answer for: ${request.sql}`)
    return { location: LOCATION, statistics: { statementType: "SELECT", totalBytesProcessed: "1048576", totalBytesProcessedAccuracy: "PRECISE", ...answer } }
  })
  h.bigquery.on("getTable", async (_account: string, ref: TableReference) => {
    const found = tables[key(ref)]
    if (found) return found
    throw new BigQueryError("NOT_FOUND", "no such table")
  })
  h.bigquery.on("getRoutine", async (_account: string, ref: RoutineReference) => {
    const found = google.routines?.[`${ref.projectId}.${ref.datasetId}.${ref.routineId}`]
    if (found) return routine({ routineReference: ref, ...found })
    throw new BigQueryError("PERMISSION_DENIED", "no access to the routine")
  })
  h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
  h.bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
  h.bigquery.on("run", async () => jobStatus())
  h.bigquery.on("results", async () => resultPage())
  return h
}

const query = (h: Harness, sql: string) => runTool(h, "query", { sql }).then((result) => result.output)
const codes = (output: Record<string, unknown>) => ((output.warnings as { code: string }[] | undefined) ?? []).map((item) => item.code)
const saveOnly = (output: Record<string, unknown>) => output.state === "done" && (output.rows as unknown[]).length === 0 && codes(output).includes("POLICY_TAGGED_SOURCE") && String(output.next).includes("bigquery_save")
const fencedTo = (datasets: string[]) => ({ accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { allow: datasets.map((dataset) => `${PROJECT}.${dataset}`) } } } })

describe("round 2, R-1: a comma join names its tables to BigQuery, so the policy-tag rule sees every one", () => {
  const texts: Record<string, TableReference[]> = {
    "SELECT customers FROM ds.orders, ds.customers": [orders, customers],
    "SELECT o FROM ds.customers, ds.orders o": [customers, orders],
    "SELECT o FROM ds.customers, ds.orders AS o": [customers, orders],
    "SELECT orders FROM ds.customers, `invented-proj.ds.orders`": [customers, orders],
    "SELECT customers FROM ds.customers, ds.orders": [customers, orders],
  }
  for (const [sql, referenced] of Object.entries(texts)) {
    it(`${sql} → save-only`, async () => {
      const output = await query(world({ answers: { [sql]: { referencedTables: referenced } } }), sql)
      expect(saveOnly(output), JSON.stringify(output)).toBe(true)
    })
  }

  it("a table function whose body comma-joins a fenced table is DATASET_FENCED, from the body's own dry run", async () => {
    const body = "SELECT a.x FROM ds.a, fenced.secret s"
    const h = world(
      {
        answers: {
          "SELECT * FROM ds.tvf()": { referencedTables: [], referencedRoutines: [rref("tvf", "ds")] },
          [body]: { referencedTables: [tableRef("a", "ds"), secret] },
        },
        tables: { [`${PROJECT}.ds.a`]: nativeTable({ tableReference: tableRef("a", "ds") }) },
        routines: { [`${PROJECT}.ds.tvf`]: { routineType: "TABLE_VALUED_FUNCTION", definitionBody: body } },
      },
      fencedTo(["ds"]),
    )
    const output = await query(h, "SELECT * FROM ds.tvf()")
    expect(output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(String(output.message)).toContain("`fenced`")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("a view whose body comma-joins a tagged table is save-only, from the view body's own dry run", async () => {
    const body = "SELECT o.id FROM ds.orders o, ds.customers"
    const h = world({
      answers: { "SELECT id FROM ds.v": { referencedTables: [], referencedLogicalViews: [tableRef("v", "ds")] }, [body]: { referencedTables: [orders, customers] } },
      tables: { [`${PROJECT}.ds.v`]: nativeTable({ tableReference: tableRef("v", "ds"), type: "VIEW", view: { query: body } }) },
    })
    expect(saveOnly(await query(h, "SELECT id FROM ds.v"))).toBe(true)
  })
})

describe("round 2, R-2: the ordinary two-part name runs, because BigQuery resolves it", () => {
  for (const sql of ["SELECT id FROM sales.orders", "SELECT id FROM `sales.orders`", "SELECT id FROM `sales`.`orders`"]) {
    it(`${sql} → done, rows inline`, async () => {
      const h = world({ answers: { [sql]: { referencedTables: [tableRef()] } } })
      const output = await query(h, sql)
      expect(output).toMatchObject({ state: "done", returned: 2 })
      expect(one(callsOf(h.bigquery, "run"))).toBeDefined()
    })
  }

  it("a one-part name with a default dataset is BigQuery's to resolve: the default goes to the dry run, and its answer decides", async () => {
    const h = world({ answers: { "SELECT id FROM orders": { referencedTables: [tableRef()] } } })
    const context = readContext({ ports: h.ports, options: h.options, account: "default", call: call(), via: "bigquery_saved_read" })
    const prepared = await prepareRead(context, { sql: "SELECT id FROM orders", defaultDataset: { projectId: PROJECT, datasetId: DATASET } }, "read")
    expect(prepared.tables.map((facts) => facts.name)).toEqual([`${PROJECT}.${DATASET}.orders`])
    expect(one(callsOf(h.bigquery, "dryRun"))[0]).toMatchObject({ defaultDataset: { projectId: PROJECT, datasetId: DATASET } })
  })

  it("a one-part name without one is refused by BigQuery, not by the plugin", async () => {
    const h = world({ answers: { "SELECT id FROM orders": "invalid" } })
    const output = await query(h, "SELECT id FROM orders")
    expect(output).toMatchObject({ state: "refused", error: "SQL_INVALID" })
    expect(needsPlan(output)).toBeUndefined()
  })
})

describe("round 1, H-2, and round 2's fresh attempts: every alias form is BigQuery's to see through", () => {
  const forms = [
    "SELECT customers FROM ds.customers",
    "SELECT customers FROM `invented-proj.ds.customers`",
    "SELECT `c` FROM ds.customers AS c",
    "SELECT `c` FROM `invented-proj`.`ds`.`customers` AS `c`",
    "WITH s AS (SELECT c FROM ds.customers c) SELECT * FROM s",
    "SELECT x FROM (SELECT customers AS x FROM ds.customers)",
    "SELECT ARRAY(SELECT c FROM ds.customers c)",
    "SELECT `t` FROM ds.customers AS `t`",
    "SELECT `T` FROM ds.customers AS t",
    "SELECT ANY_VALUE(z) FROM ds.customers z",
    "SELECT o FROM ds.orders o JOIN ds.customers c USING (id)",
    "SELECT u FROM ds.customers c, UNNEST([c]) AS u",
    "SELECT id FROM ds.customers",
    "SELECT COUNT(*) FROM ds.customers WHERE ssn = '123-45-6789'",
  ]
  for (const sql of forms) {
    it(`${sql} → save-only`, async () => {
      const referenced = sql.includes("ds.orders") ? [orders, customers] : [customers]
      expect(saveOnly(await query(world({ answers: { [sql]: { referencedTables: referenced } } }), sql))).toBe(true)
    })
  }

  it("a text that seems to name a tagged table only in a string or a comment is judged by BigQuery's answer, not the text", async () => {
    const sql = "SELECT 'FROM ds.customers' AS note, id FROM ds.orders -- JOIN ds.customers"
    const output = await query(world({ answers: { [sql]: { referencedTables: [orders] } } }), sql)
    expect(output).toMatchObject({ state: "done", returned: 2 })
  })

  it("policyTagged: allow, the person's option, is the only way to tagged rows inline", async () => {
    const sql = "SELECT customers FROM ds.customers"
    const output = await query(world({ answers: { [sql]: { referencedTables: [customers] } } }, { policyTagged: "allow" }), sql)
    expect(output).toMatchObject({ state: "done", returned: 2 })
  })
})

describe("round 1, H-3: routine bodies are analysed by their own dry run", () => {
  const remote = { remoteFunctionOptions: { endpoint: "https://invented.invalid/fn" } }

  it("a routine calling a routine calling a remote function is an external effect at depths 1, 2 and 3", async () => {
    for (const depth of [1, 2, 3]) {
      const answers: Google["answers"] = { "SELECT `invented-proj.sales.r1`(1)": { referencedTables: [], referencedRoutines: [rref("r1")] } }
      const routines: Google["routines"] = {}
      for (let level = 1; level < depth; level += 1) {
        const body = `body_${level}`
        routines[`${PROJECT}.${DATASET}.r${level}`] = { definitionBody: body }
        answers[`SELECT (\n${body}\n)`] = { referencedRoutines: [rref(`r${level + 1}`)] }
      }
      routines[`${PROJECT}.${DATASET}.r${depth}`] = remote
      const output = await query(world({ answers, routines }), "SELECT `invented-proj.sales.r1`(1)")
      expect(needsPlan(output), `depth ${depth}`).toBe("EXTERNAL_EFFECTS")
    }
  })

  it("a fourth level is unresolved", async () => {
    const answers: Google["answers"] = { "SELECT `invented-proj.sales.r1`(1)": { referencedTables: [], referencedRoutines: [rref("r1")] } }
    const routines: Google["routines"] = {}
    for (let level = 1; level <= 4; level += 1) {
      routines[`${PROJECT}.${DATASET}.r${level}`] = { definitionBody: `body_${level}` }
      answers[`SELECT (\nbody_${level}\n)`] = { referencedRoutines: level < 4 ? [rref(`r${level + 1}`)] : [] }
    }
    expect(needsPlan(await query(world({ answers, routines }), "SELECT `invented-proj.sales.r1`(1)"))).toBe("UNRESOLVED_REFERENCE")
  })

  it("a routine whose definition cannot be read, or whose body BigQuery will not dry-run (an authorised routine), is unresolved", async () => {
    const unreadable = world({ answers: { "SELECT `invented-proj.sales.gone`(1)": { referencedRoutines: [rref("gone")] } } })
    expect(needsPlan(await query(unreadable, "SELECT `invented-proj.sales.gone`(1)"))).toBe("UNRESOLVED_REFERENCE")

    const authorised = world({
      answers: { "SELECT `invented-proj.sales.auth`(1)": { referencedRoutines: [rref("auth")] }, "SELECT (\n(SELECT COUNT(*) FROM hidden.t)\n)": "invalid" },
      routines: { [`${PROJECT}.${DATASET}.auth`]: { definitionBody: "(SELECT COUNT(*) FROM hidden.t)" } },
    })
    expect(needsPlan(await query(authorised, "SELECT `invented-proj.sales.auth`(1)"))).toBe("UNRESOLVED_REFERENCE")
  })

  it("a scalar function's subquery over a tagged table makes the result save-only", async () => {
    const body = "(SELECT MAX(ssn) FROM ds.customers WHERE id = x)"
    const h = world({
      answers: {
        "SELECT `invented-proj.sales.lookup`(id) FROM ds.orders": { referencedTables: [orders], referencedRoutines: [rref("lookup")] },
        "SELECT (\n(SELECT MAX(ssn) FROM ds.customers WHERE id = (CAST(NULL AS INT64)))\n)": { referencedTables: [customers] },
      },
      routines: { [`${PROJECT}.${DATASET}.lookup`]: { definitionBody: body, arguments: [{ name: "x", dataType: { typeKind: "INT64" } }] } },
    })
    expect(saveOnly(await query(h, "SELECT `invented-proj.sales.lookup`(id) FROM ds.orders"))).toBe(true)
  })

  it("a table reached through a routine body meets the person's own deny rule on its table resource (review M-2)", async () => {
    const body = "SELECT * FROM fenced.secret"
    const h = world({
      answers: { "SELECT * FROM ds.tvf()": { referencedRoutines: [rref("tvf", "ds")] }, [body]: { referencedTables: [secret] } },
      routines: { [`${PROJECT}.ds.tvf`]: { routineType: "TABLE_VALUED_FUNCTION", definitionBody: body } },
    })
    // The host's own denial ends the call, as it does for every assert (test/unit/reads/query.test.ts).
    await expect(
      runTool(h, "query", { sql: "SELECT * FROM ds.tvf()" }, { deny: (request) => request.resources.includes("default:table:invented-proj.fenced.secret") }),
    ).rejects.toThrow("denied by the rules")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })
})

describe("what the lexer still decides, and what fails closed", () => {
  it("a temporary function is refused, whatever its body, before anything runs", async () => {
    const sql = "CREATE TEMP FUNCTION f() AS ((SELECT MAX(ssn) FROM ds.customers)); SELECT f()"
    const h = world({ answers: { [sql]: { referencedTables: [] } } })
    const output = await query(h, sql)
    expect(needsPlan(output)).toBe("UNRESOLVED_REFERENCE")
    expect(String(output.message)).toContain("temporary function")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("a property graph is unresolved, and fenced when it is outside the fence", async () => {
    const sql = "SELECT * FROM GRAPH_TABLE(ds.g MATCH (n) RETURN n.id)"
    const graph = { referencedPropertyGraphs: [{ projectId: PROJECT, datasetId: "ds", propertyGraphId: "g" }] }
    expect(needsPlan(await query(world({ answers: { [sql]: graph } }), sql))).toBe("UNRESOLVED_REFERENCE")
    expect(await query(world({ answers: { [sql]: graph } }, fencedTo(["sales"])), sql)).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
  })

  it("a wildcard name BigQuery lists as a pattern cannot be read as a table, so it is unresolved", async () => {
    const sql = "SELECT id FROM ds.events_*"
    expect(needsPlan(await query(world({ answers: { [sql]: { referencedTables: [tableRef("events_*", "ds")] } } }), sql))).toBe("UNRESOLVED_REFERENCE")
  })

  it("a region-level INFORMATION_SCHEMA view under an allow fence is refused, after a comma too (round 1, LOW 1)", async () => {
    for (const sql of ["SELECT * FROM `region-us`.INFORMATION_SCHEMA.COLUMNS", "SELECT 1 FROM ds.orders, `region-us`.INFORMATION_SCHEMA.JOBS_BY_USER"]) {
      const h = world({ answers: { [sql]: { referencedTables: [] } } }, fencedTo(["ds"]))
      expect(await query(h, sql), sql).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
      expect(callsOf(h.bigquery, "dryRun"), sql).toEqual([])
    }
  })

  it("an INFORMATION_SCHEMA view in a referenced list is metadata, never read with tables.get", () => {
    for (const ref of [tableRef("TABLES", "INFORMATION_SCHEMA"), tableRef("INFORMATION_SCHEMA.COLUMNS", "sales"), { projectId: "region-us", datasetId: "INFORMATION_SCHEMA", tableId: "JOBS" }]) {
      expect(isInformationSchema(ref), JSON.stringify(ref)).toBe(true)
    }
    expect(isInformationSchema(tableRef())).toBe(false)
  })

  it("the dry run never asks for the query cache, so a cache hit cannot empty the referenced lists; the run may still use it", async () => {
    const sql = "SELECT id FROM sales.orders"
    const h = world({ answers: { [sql]: { referencedTables: [tableRef()] } } })
    await runTool(h, "query", { sql, useCache: true })
    expect(one(callsOf(h.bigquery, "dryRun"))[0]).toMatchObject({ useQueryCache: false })
    expect(one(callsOf(h.bigquery, "run"))[0]).toMatchObject({ useQueryCache: true })
  })

  it("a dry run that fails refuses: no read runs on the lexer's word alone", async () => {
    const h = world({ answers: { "SELECT id FROM ds.orders": "invalid" } })
    expect(await query(h, "SELECT id FROM ds.orders")).toMatchObject({ state: "refused", error: "SQL_INVALID" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })
})

describe("bigquery_job (round 1, H-1, and round 2, LOW 2)", () => {
  it("a job a fresh process never prepared, over a tagged table, is save-only", async () => {
    const h = world({ answers: {} })
    h.bigquery.on("getJob", async () => jobStatus({ referencedTables: [customers] }))
    const { output } = await runTool(h, "job", { project: PROJECT, jobId: "oc_elsewhere" })
    expect(saveOnly(output)).toBe(true)
  })

  it("an unprepared cache hit that names nothing is save-only, and refused under a fence, because nothing can be checked", async () => {
    const open = world({ answers: {} })
    open.bigquery.on("getJob", async () => jobStatus({ cacheHit: true, totalBytesBilled: 0, referencedTables: [] }))
    const { output } = await runTool(open, "job", { project: PROJECT, jobId: "oc_cached" })
    expect(output).toMatchObject({ state: "done", rows: [], returned: 0 })
    expect(String(output.next)).toContain("bigquery_save")

    const fenced = world({ answers: {} }, fencedTo(["sales"]))
    fenced.bigquery.on("getJob", async () => jobStatus({ cacheHit: true, totalBytesBilled: 0 }))
    expect((await runTool(fenced, "job", { project: PROJECT, jobId: "oc_cached" })).output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(callsOf(fenced.bigquery, "results")).toEqual([])
  })

  it("an unprepared SELECT 1 that is not a cache hit and names nothing still pages inline", async () => {
    const h = world({ answers: {} })
    h.bigquery.on("getJob", async () => jobStatus({ referencedTables: [] }))
    expect((await runTool(h, "job", { project: PROJECT, jobId: "oc_one" })).output).toMatchObject({ state: "done", returned: 2 })
  })
})

describe("bigquery_profile over a table knows its own columns", () => {
  const tagged = nativeTable({ schema: { fields: [{ name: "id", type: "INT64" }, { name: "ssn", type: "STRING", policyTags: TAG }] } })

  it("profiles a tagged table's untagged columns inline: the plugin wrote the SQL from the schema and left ssn out", async () => {
    const h = harness()
    h.bigquery.on("getTable", async () => tagged)
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics() }))
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    h.bigquery.on("run", async () => jobStatus())
    h.bigquery.on("results", async () => resultPage({ schema: [{ name: "column_name", type: "STRING" }], rows: [{ f: [{ v: "id" }] }] }))
    const { output } = await runTool(h, "profile", { table: "sales.orders" })
    expect(output).toMatchObject({ state: "done" })
    expect(output.columns).toEqual([{ column: "id" }])
    expect((one(callsOf(h.bigquery, "dryRun"))[0] as { sql: string }).sql).not.toContain("ssn")
  })

  it("refuses a SELECT source over a tagged table: its columns are the model's text, not the plugin's", async () => {
    const sql = "SELECT id FROM ds.customers"
    const h = world({ answers: {} })
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ referencedTables: [customers] }) }))
    const { output } = await runTool(h, "profile", { sql, columns: ["id"] })
    expect(output).toMatchObject({ state: "refused", error: "COLUMN_DENIED" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })
})

function one<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1)
  return values[0]!
}
