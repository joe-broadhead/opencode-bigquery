// The eight read tools' own behaviour: list, table, search, estimate, job, jobs and profile, each through the registry
// with the fakes. Every billed read goes through the guards, so a search's views and a profile are checked the same way
// as a query; the free tools make only free calls.
import { describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { LOCATION, PROJECT, callsOf, harness, jobStatus, nativeTable, one, resultPage, runTool, scriptNativeRead, statistics, tableRef } from "./support.js"

describe("bigquery_list", () => {
  it("lists projects with no project, datasets with one, and tables with a dataset", async () => {
    const projects = harness()
    projects.bigquery.on("listProjects", async () => ({ items: [{ projectId: "alpha-1", friendlyName: "Alpha" }, { projectId: "beta-22" }] }))
    expect((await runTool(projects, "list", {})).output).toMatchObject({ state: "done", items: [{ project: "alpha-1", name: "Alpha" }, { project: "beta-22" }], trust: "untrusted" })

    const datasets = harness()
    datasets.bigquery.on("listDatasets", async () => ({ items: [{ ref: { projectId: PROJECT, datasetId: "sales" }, location: LOCATION }], nextPageToken: "next" }))
    expect((await runTool(datasets, "list", { project: PROJECT })).output).toMatchObject({ items: [{ project: PROJECT, dataset: "sales", location: "US" }], nextPageToken: "next" })

    const tables = harness()
    tables.bigquery.on("listTables", async () => ({ items: [nativeTable(), nativeTable({ tableReference: tableRef("returns") })] }))
    expect((await runTool(tables, "list", { project: PROJECT, dataset: "sales" })).output).toMatchObject({ state: "done", items: [{ table: "orders" }, { table: "returns" }] })
  })

  it("adds rows, bytes and modified for the first 25 tables with details", async () => {
    const h = harness()
    h.bigquery.on("listTables", async () => ({ items: Array.from({ length: 30 }, (_, index) => nativeTable({ tableReference: tableRef(`t${index}`, "sales") })) }))
    h.bigquery.on("getTable", async (_account: string, ref: { projectId: string; datasetId: string; tableId: string }) => nativeTable({ tableReference: ref }))
    const { output } = await runTool(h, "list", { project: PROJECT, dataset: "sales", details: true })
    expect(callsOf(h.bigquery, "getTable")).toHaveLength(25)
    expect((output.items as Record<string, unknown>[])[0]).toMatchObject({ rows: 100, bytes: 1048576, modified: "2026-11-17T10:00:00.000Z" })
    expect((output.items as Record<string, unknown>[])[25]).not.toHaveProperty("rows")
  })

  it("lists routines with their language and whether they are remote", async () => {
    const h = harness()
    h.bigquery.on("listRoutines", async () => ({
      items: [
        { routineReference: { projectId: PROJECT, datasetId: "sales", routineId: "fn" }, routineType: "SCALAR_FUNCTION", language: "SQL", arguments: [{ name: "x" }] },
        { routineReference: { projectId: PROJECT, datasetId: "sales", routineId: "remote" }, routineType: "SCALAR_FUNCTION", language: "SQL", remoteFunctionOptions: {} },
      ],
    }))
    const { output } = await runTool(h, "list", { project: PROJECT, dataset: "sales", kind: "routines" })
    expect(output.items).toEqual([
      { project: PROJECT, dataset: "sales", routine: "fn", type: "SCALAR_FUNCTION", language: "SQL", remote: false, arguments: 1 },
      { project: PROJECT, dataset: "sales", routine: "remote", type: "SCALAR_FUNCTION", language: "SQL", remote: true },
    ])
  })

  it("keeps the filter case-insensitive, and refuses a dataset with no project", async () => {
    const h = harness()
    h.bigquery.on("listTables", async () => ({ items: [nativeTable(), nativeTable({ tableReference: tableRef("Returns") })] }))
    expect((await runTool(h, "list", { project: PROJECT, dataset: "sales", filter: "RET" })).output).toMatchObject({ items: [{ table: "Returns" }] })
    expect((await runTool(h, "list", { dataset: "sales" })).output).toMatchObject({ error: "INPUT_INVALID" })
    expect((await runTool(h, "list", { project: PROJECT, kind: "routines" })).output).toMatchObject({ error: "INPUT_INVALID" })
  })
})

describe("bigquery_table", () => {
  const nested = nativeTable({
    schema: {
      fields: [
        { name: "id", type: "INT64", mode: "REQUIRED", description: "the id" },
        { name: "customer", type: "RECORD", fields: [{ name: "name", type: "STRING" }, { name: "ssn", type: "STRING", policyTags: { names: ["projects/p/locations/us/taxonomies/1/policyTags/2"] } }] },
      ],
    },
    timePartitioning: { type: "DAY", field: "day", requirePartitionFilter: true },
    clustering: { fields: ["id"] },
  })

  it("flattens the schema, shows partitioning and clustering, and cuts the view SQL", async () => {
    const h = harness()
    h.bigquery.on("getTable", async () => nested)
    const { output } = await runTool(h, "table", { project: PROJECT, dataset: "sales", table: "orders" })
    expect(output.columns).toEqual([
      { path: "id", type: "INT64", mode: "REQUIRED", description: "the id", policyTag: false },
      { path: "customer", type: "RECORD", policyTag: false },
      { path: "customer.name", type: "STRING", policyTag: false },
      { path: "customer.ssn", type: "STRING", policyTag: true },
    ])
    expect(output.partitioning).toEqual({ type: "DAY", field: "day", requirePartitionFilter: true })
    expect(output.clustering).toEqual(["id"])
    expect(output).toMatchObject({ rows: 100, bytes: 1048576, modified: "2026-11-17T10:00:00.000Z", trust: "untrusted" })
  })

  it("shows a view's SQL, cut to 2000 characters", async () => {
    const h = harness()
    h.bigquery.on("getTable", async () => nativeTable({ type: "VIEW", view: { query: `SELECT ${"x".repeat(3_000)}` } }))
    const { output } = await runTool(h, "table", { dataset: "sales", table: "orders" })
    expect(String(output.viewSql)).toHaveLength(2_000)
  })

  it("adds per-partition rows and bytes from INFORMATION_SCHEMA.PARTITIONS, under the read path's cap", async () => {
    const h = harness()
    h.bigquery.on("getTable", async () => nativeTable())
    h.bigquery.on("dryRun", async (request: { sql: string }) => ({
      location: LOCATION,
      statistics: request.sql.includes("INFORMATION_SCHEMA.PARTITIONS")
        ? { statementType: "SELECT", totalBytesProcessed: "10485760", totalBytesProcessedAccuracy: "PRECISE", referencedTables: [], schema: { fields: [{ name: "partition_id", type: "STRING" }] } }
        : statistics(),
    }))
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    h.bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
    h.bigquery.on("run", async () => jobStatus())
    h.bigquery.on("results", async () => resultPage({ schema: [{ name: "partition_id", type: "STRING" }], rows: [{ f: [{ v: "orders" }, { v: "20261101" }, { v: "5" }, { v: "100" }, { v: null }] }] }))
    const { output } = await runTool(h, "table", { dataset: "sales", table: "orders", partitions: true })
    const dry = one(callsOf(h.bigquery, "dryRun"))[0] as { sql: string }
    expect(dry.sql).toContain("INFORMATION_SCHEMA.PARTITIONS")
    expect(dry.sql).toContain("WHERE table_name = @table")
    expect(output.partitions).toEqual([{ partition: "20261101", rows: 5, bytes: 100 }])
  })
})

describe("bigquery_search", () => {
  const regionRows = () => ({
    complete: true,
    schema: [{ name: "table_name", type: "STRING" }],
    rows: [
      { f: [{ v: PROJECT }, { v: "sales" }, { v: "orders" }, { v: "id" }, { v: "id" }, { v: "" }] },
      { f: [{ v: PROJECT }, { v: "private" }, { v: "secret_orders" }, { v: "ssn" }, { v: "ssn" }, { v: "orders per person" }] },
    ],
  })

  it("reads the region view first, filters it through the fence, and says so", async () => {
    const h = harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { deny: [`${PROJECT}.private`] } } } })
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ totalBytesProcessed: "10485760", referencedTables: [] }) }))
    h.bigquery.on("run", async () => jobStatus())
    h.bigquery.on("results", async () => regionRows())
    const { output } = await runTool(h, "search", { project: PROJECT, location: LOCATION, query: "orders" })
    expect(output.via).toBe("region")
    expect(output.matches).toEqual([{ table: { project: PROJECT, dataset: "sales", table: "orders" }, column: "id", where: "name" }])
    expect(output).toMatchObject({ bytesProcessed: 1048576, bytesBilled: 1048576 })
    expect((one(callsOf(h.bigquery, "dryRun"))[0] as { sql: string }).sql).toContain("`region-us`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS")
  })

  it("falls back to each dataset's own view when the region view is refused, then to plain names", async () => {
    const dataset = harness()
    dataset.bigquery.on("dryRun", async (request: { sql: string }) => {
      if (request.sql.includes("`region-us`")) throw new BigQueryError("PERMISSION_DENIED", "the region view needs project-level permission")
      return { location: LOCATION, statistics: statistics({ totalBytesProcessed: "10485760", referencedTables: [] }) }
    })
    dataset.bigquery.on("run", async () => jobStatus())
    dataset.bigquery.on("results", async () => regionRows())
    dataset.bigquery.on("listDatasets", async () => ({ items: [{ ref: { projectId: PROJECT, datasetId: "sales" } }] }))
    expect((await runTool(dataset, "search", { project: PROJECT, location: LOCATION, query: "orders" })).output.via).toBe("dataset")

    const names = harness()
    names.bigquery.on("dryRun", async () => {
      throw new BigQueryError("PERMISSION_DENIED", "no view for you")
    })
    names.bigquery.on("listDatasets", async () => ({ items: [{ ref: { projectId: PROJECT, datasetId: "sales" } }] }))
    names.bigquery.on("listTables", async () => ({ items: [nativeTable({ tableReference: tableRef("orders"), description: "orders per person" })] }))
    const { output } = await runTool(names, "search", { project: PROJECT, location: LOCATION, query: "orders" })
    expect(output.via).toBe("names")
    expect(output.matches).toEqual([{ table: { project: PROJECT, dataset: "sales", table: "orders" }, where: "name" }])
  })

  it("escapes the caller's words for LIKE, so % and _ are literals", async () => {
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ totalBytesProcessed: "10485760", referencedTables: [] }) }))
    h.bigquery.on("run", async () => jobStatus())
    h.bigquery.on("results", async () => resultPage({ rows: [{ f: [{ v: PROJECT }, { v: "sales" }, { v: "pct_50" }, { v: "" }, { v: "" }, { v: "the 50% mark" }] }] }))
    h.bigquery.on("listDatasets", async () => ({ items: [{ ref: { projectId: PROJECT, datasetId: "sales" } }] }))
    h.bigquery.on("listTables", async () => ({ items: [] }))
    await runTool(h, "search", { project: PROJECT, location: LOCATION, query: "50%_x" })
    expect((one(callsOf(h.bigquery, "dryRun"))[0] as { params: unknown }).params).toEqual([{ name: "q", parameterType: { type: "STRING" }, parameterValue: { value: "%50\\%\\_x%" } }])
  })
})

describe("bigquery_estimate", () => {
  it("dry-runs only, and answers the type, category, references, bytes, cost, cap and hints", async () => {
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics() }))
    h.bigquery.on("getTable", async () => nativeTable())
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    h.bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
    const { output } = await runTool(h, "estimate", { sql: "SELECT id FROM `invented-proj.sales.orders`" })
    expect(output).toMatchObject({
      state: "done",
      statementType: "SELECT",
      category: "read",
      referenced: { tables: [`${PROJECT}.sales.orders`], views: [], routines: [], propertyGraphs: [] },
      bytes: 1048576,
      accuracy: "PRECISE",
      costUsd: expect.any(Number),
      capEnforceable: true,
      location: "US",
    })
    expect(output.schema).toEqual([{ name: "id", type: "INT64" }])
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("classifies a change without refusing it, and says why the cap cannot bound it", async () => {
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: { ...statistics(), statementType: "DELETE", totalBytesProcessedAccuracy: "LOWER_BOUND" } }))
    h.bigquery.on("getTable", async () => nativeTable())
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    h.bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
    const { output } = await runTool(h, "estimate", { sql: "DELETE FROM `invented-proj.sales.orders` WHERE TRUE" })
    expect(output).toMatchObject({ category: "delete", capEnforceable: false, whyNot: expect.stringContaining("lower bound") })
  })

  it("refuses a type this version does not know", async () => {
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: { ...statistics(), statementType: "IMPORT_DATA" } }))
    expect((await runTool(h, "estimate", { sql: "SELECT 1" })).output).toMatchObject({ error: "STATEMENT_UNKNOWN" })
  })
})

describe("bigquery_job", () => {
  it("answers a finished job with a page of its results", async () => {
    const h = harness()
    h.bigquery.on("getJob", async () => jobStatus())
    h.bigquery.on("results", async () => resultPage())
    const { output } = await runTool(h, "job", { project: PROJECT, jobId: "oc_1", location: LOCATION })
    expect(output).toMatchObject({ state: "done", jobState: "DONE", statementType: "SELECT", bytesBilled: 1048576, returned: 2, trust: "untrusted" })
    expect(one(callsOf(h.bigquery, "results"))[2]).toMatchObject({ maxResults: 51 })
  })

  it("answers running with a next step and reads no results without a wait", async () => {
    const h = harness()
    h.bigquery.on("getJob", async () => jobStatus({ state: "RUNNING", endTime: undefined }))
    const { output } = await runTool(h, "job", { project: PROJECT, jobId: "oc_1" })
    expect(output).toMatchObject({ state: "running", jobState: "RUNNING" })
    expect(String(output.next)).toContain("bigquery_job")
    expect(callsOf(h.bigquery, "results")).toEqual([])
  })

  it("long-polls a running job with wait, and answers its rows once it finishes", async () => {
    const h = harness()
    let calls = 0
    h.bigquery.on("getJob", async () => {
      calls += 1
      return calls === 1 ? jobStatus({ state: "RUNNING", endTime: undefined }) : jobStatus()
    })
    h.bigquery.on("results", async () => resultPage())
    const { output } = await runTool(h, "job", { project: PROJECT, jobId: "oc_1", wait: 5 })
    expect(output).toMatchObject({ state: "done", jobState: "DONE", returned: 2, bytesBilled: 1048576 })
    expect(one(callsOf(h.bigquery, "results"))[2]).toMatchObject({ timeoutMs: 5_000 })
    expect(callsOf(h.bigquery, "getJob")).toHaveLength(2)
  })

  it("keeps waiting when the long poll runs out, and still reads no rows", async () => {
    const h = harness()
    h.bigquery.on("getJob", async () => jobStatus({ state: "RUNNING", endTime: undefined }))
    h.bigquery.on("results", async () => ({ complete: false, rows: [] }))
    const { output } = await runTool(h, "job", { project: PROJECT, jobId: "oc_1", wait: 5 })
    expect(output).toMatchObject({ state: "running", jobState: "RUNNING" })
    expect(output.rows).toBeUndefined()
  })

  it("answers a failed job with its code and Google's text in googleError", async () => {
    const h = harness()
    h.bigquery.on("getJob", async () => jobStatus({ error: { reason: "invalidQuery", location: "query", message: "Syntax error: Unexpected end of script" } }))
    const { output } = await runTool(h, "job", { project: PROJECT, jobId: "oc_1" })
    expect(output).toMatchObject({ state: "failed", error: "SQL_INVALID" })
    expect(output.googleError).toEqual({ reason: "invalidQuery", location: "query", message: "Syntax error: Unexpected end of script", trust: "untrusted" })
  })

  it("reads no result page for a job with no result rows, or when maxRows is 0", async () => {
    for (const [status, maxRows] of [[jobStatus({ statementType: "CREATE_TABLE" }), 50], [jobStatus(), 0]] as const) {
      const h = harness()
      h.bigquery.on("getJob", async () => status)
      const { output } = await runTool(h, "job", { project: PROJECT, jobId: "oc_1", maxRows })
      expect(output).toMatchObject({ state: "done" })
      expect(callsOf(h.bigquery, "results")).toEqual([])
    }
  })

  it("maps a missing result table to RESULTS_EXPIRED", async () => {
    const h = harness()
    h.bigquery.on("getJob", async () => jobStatus({ endTime: Date.parse("2026-11-15T12:00:00Z") }))
    h.bigquery.on("results", async () => {
      throw new BigQueryError("NOT_FOUND", "no such table")
    })
    expect((await runTool(h, "job", { project: PROJECT, jobId: "oc_1" })).output).toMatchObject({ error: "RESULTS_EXPIRED" })
  })
})

describe("bigquery_jobs", () => {
  it("lists the account's jobs newest first with labels, bytes and a cut SQL preview", async () => {
    const h = harness()
    h.bigquery.on("listJobs", async () => ({
      items: [jobStatus({ labels: { oc_tool: "bigquery_query" }, sqlPreview: `SELECT ${"x".repeat(300)}` })],
      nextPageToken: "page2",
    }))
    const { output } = await runTool(h, "jobs", { project: PROJECT, state: "done", limit: 10 })
    expect(one(callsOf(h.bigquery, "listJobs"))[0]).toMatchObject({ project: PROJECT, stateFilter: "done", maxResults: 10 })
    expect(output).toMatchObject({ state: "done", nextPageToken: "page2", trust: "untrusted" })
    expect((output.jobs as Record<string, unknown>[])[0]).toMatchObject({ jobState: "DONE", statementType: "SELECT", bytesBilled: 1048576, labels: { oc_tool: "bigquery_query" } })
    expect(String((output.jobs as { sql: string }[])[0]!.sql)).toHaveLength(200)
  })
})

describe("bigquery_profile", () => {
  const scriptProfile = (h: ReturnType<typeof harness>) => {
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics() }))
    h.bigquery.on("getTable", async () => nativeTable({ schema: { fields: [{ name: "id", type: "INT64" }, { name: "amount", type: "FLOAT64" }, { name: "note", type: "STRING" }, { name: "tags", type: "STRING", mode: "REPEATED" }] } }))
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    h.bigquery.on("run", async () => jobStatus())
    h.bigquery.on("results", async () =>
      resultPage({
        schema: [
          { name: "column_name", type: "STRING" },
          { name: "nulls", type: "INT64" },
          { name: "distinct_approx", type: "INT64" },
          { name: "min_value", type: "STRING" },
          { name: "max_value", type: "STRING" },
          { name: "quantiles", type: "STRING" },
          { name: "top_values", type: "STRING" },
        ],
        rows: [
          { f: [{ v: "id" }, { v: "0" }, { v: "100" }, { v: "1" }, { v: "100" }, { v: "[1,50,100,100]" }, { v: '[{"value":"1","count":100}]' }] },
          { f: [{ v: "amount" }, { v: "0" }, { v: "100" }, { v: "0.5" }, { v: "99.5" }, { v: "[0.5,25,50,99.5]" }, { v: "[]" }] },
          { f: [{ v: "note" }, { v: "5" }, { v: "80" }, { v: "a" }, { v: "z" }, { v: null }, { v: "[]" }] },
          { f: [{ v: "tags" }, { v: "0" }, { v: "40" }, { v: null }, { v: null }, { v: null }, { v: null }] },
        ],
      }),
    )
  }

  it("profiles a table in one aggregate query, and maps its rows", async () => {
    const h = harness()
    scriptProfile(h)
    const { output } = await runTool(h, "profile", { table: "sales.orders" })
    const sql = (one(callsOf(h.bigquery, "dryRun"))[0] as { sql: string }).sql
    expect(sql).toContain("COUNTIF(`id` IS NULL)")
    expect(sql).toContain("APPROX_QUANTILES(`id`, 4)")
    expect(sql).toContain("APPROX_TOP_COUNT(`amount`, 5)")
    expect(sql).toContain("FROM `invented-proj`.`sales`.`orders`")
    // A repeated column has no MIN/MAX/quantiles, and still appears.
    expect(sql).toContain("`tags`")
    expect(sql).not.toContain("MIN(`tags`)")
    const [id, amount, note, tags] = output.columns as Record<string, unknown>[]
    expect(id).toEqual({ column: "id", nulls: 0, distinctApprox: 100, min: "1", max: "100", quantiles: [1, 50, 100, 100], top: [{ value: "1", count: 100 }] })
    expect(amount).toEqual({ column: "amount", nulls: 0, distinctApprox: 100, min: "0.5", max: "99.5", quantiles: [0.5, 25, 50, 99.5], top: [] })
    expect(note).toEqual({ column: "note", nulls: 5, distinctApprox: 80, min: "a", max: "z", top: [] })
    // A repeated column has no min, max, quantiles or top values, and it still appears.
    expect(tags).toEqual({ column: "tags", nulls: 0, distinctApprox: 40 })
    expect(output.job).toMatchObject({ location: "US" })
  })

  it("profiles a SELECT only when the columns are named, and never as two statements", async () => {
    const named = harness()
    scriptProfile(named)
    const { output } = await runTool(named, "profile", { sql: "SELECT id, note FROM `invented-proj.sales.orders`", columns: ["id", "note"] })
    expect(output).toMatchObject({ state: "done" })
    expect((one(callsOf(named.bigquery, "dryRun"))[0] as { sql: string }).sql).toContain("FROM (SELECT id, note FROM `invented-proj.sales.orders`)")

    expect((await runTool(named, "profile", { sql: "SELECT id FROM t" })).output).toMatchObject({ error: "INPUT_INVALID" })
    expect((await runTool(named, "profile", { sql: "SELECT 1; SELECT 2", columns: ["id"] })).output).toMatchObject({ error: "INPUT_INVALID" })
  })

  it("refuses a tagged column unless policyTagged: allow", async () => {
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics() }))
    h.bigquery.on("getTable", async () => nativeTable({ schema: { fields: [{ name: "id", type: "INT64" }, { name: "ssn", type: "STRING", policyTags: { names: ["projects/p/locations/us/taxonomies/1/policyTags/2"] } }] } }))
    expect((await runTool(h, "profile", { table: "sales.orders", columns: ["ssn"] })).output).toMatchObject({ error: "COLUMN_DENIED" })
    // With no columns named, the tagged one is simply left out.
    h.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    h.bigquery.on("run", async () => jobStatus())
    h.bigquery.on("results", async () => resultPage({ rows: [] }))
    await runTool(h, "profile", { table: "sales.orders" })
    const sql = (one(callsOf(h.bigquery, "dryRun"))[0] as { sql: string }).sql
    expect(sql).toContain("`id`")
    expect(sql).not.toContain("`ssn`")
  })

  it("refuses TABLESAMPLE on a row-secured table, and refuses a view", async () => {
    const secured = harness()
    secured.bigquery.on("getTable", async () => nativeTable())
    secured.bigquery.on("listRowAccessPolicies", async () => ({ items: [{ policyId: "invented" }] }))
    expect((await runTool(secured, "profile", { table: "sales.orders", samplePercent: 10 })).output).toMatchObject({ error: "INPUT_INVALID" })

    const view = harness()
    view.bigquery.on("getTable", async () => nativeTable({ type: "VIEW", view: { query: "SELECT 1" } }))
    expect((await runTool(view, "profile", { table: "sales.orders" })).output).toMatchObject({ error: "INPUT_INVALID" })
  })
})
