// Design §14.1 "Read path order" and the query tool: no run without a full dry run, every run guarded and labelled,
// byte-identical SQL and parameters, the refusals, the running case, the cap, the budget and the uncapped-read plan.
import { describe, expect, it } from "vitest"
import { ASKS } from "../../../src/domain/actions.js"
import { needsPlan } from "./expect.js"
import { LOCATION, PROJECT, callsOf, harness, jobStatus, one, resultPage, runTool, scriptNativeRead, signedIn, statistics } from "./support.js"

const SQL = "SELECT id FROM `invented-proj.sales.orders`"

describe("the read path's order (§5.1)", () => {
  it("runs only after a dry run, and sends the same SQL and parameters to both", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    const { output } = await runTool(h, "query", { sql: SQL, params: { n: 1, label: "x" } })
    expect(output).toMatchObject({ state: "done", returned: 2, trust: "untrusted" })

    const dry = one(callsOf(h.bigquery, "dryRun"))
    const run = one(callsOf(h.bigquery, "run"))
    expect(dry[0]).toMatchObject({ account: "default", project: "invented-proj", sql: SQL })
    expect(run[0]).toMatchObject({ account: "default", project: "invented-proj", sql: SQL })
    expect((run[0] as { params: unknown }).params).toEqual((dry[0] as { params: unknown }).params)
    expect((dry[0] as { params: unknown[] }).params).toEqual([
      { name: "label", parameterType: { type: "STRING" }, parameterValue: { value: "x" } },
      { name: "n", parameterType: { type: "INT64" }, parameterValue: { value: "1" } },
    ])
  })

  it("answers DRY_RUN_INCOMPLETE when the dry run carries no statistics.query, and runs nothing", async () => {
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: "US" }))
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output).toMatchObject({ state: "refused", error: "DRY_RUN_INCOMPLETE" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("answers DRY_RUN_INCOMPLETE when the statistics name no statement type", async () => {
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: "US", statistics: { totalBytesProcessed: "10" } }))
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output).toMatchObject({ error: "DRY_RUN_INCOMPLETE" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("refuses a script, DML and an unknown type before any run, pointing at bigquery_plan", async () => {
    for (const [type, error] of [
      ["DELETE", "STATEMENT_NOT_READ"],
      ["SCRIPT", "STATEMENT_NOT_READ"],
      ["CALL", "STATEMENT_NOT_READ"],
      ["IMPORT_DATA", "STATEMENT_UNKNOWN"],
    ] as const) {
      const h = harness()
      h.bigquery.on("dryRun", async () => ({ location: "US", statistics: { ...statistics(), statementType: type } }))
      const { output } = await runTool(h, "query", { sql: SQL })
      expect(output, type).toMatchObject({ state: "refused", error })
      expect(callsOf(h.bigquery, "run"), type).toEqual([])
    }
    const h = harness()
    h.bigquery.on("dryRun", async () => ({ location: "US", statistics: { ...statistics(), statementType: "DELETE" } }))
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(String(output.next)).toContain("bigquery_plan")
  })

  it("refuses legacy SQL and a failed lex before any Google call", async () => {
    for (const [sql, error] of [
      ["#legacySQL\nSELECT 1", "LEGACY_SQL_REFUSED"],
      ["SELECT 'unterminated", "SQL_INVALID"],
      ["SELECT /* unterminated", "SQL_INVALID"],
    ] as const) {
      const h = harness()
      scriptNativeRead(h.bigquery)
      const { output } = await runTool(h, "query", { sql })
      expect(output, sql).toMatchObject({ state: "refused", error })
      expect(h.bigquery.calls, sql).toEqual([])
    }
  })

  it("gives every run a client job id, the cap, the labels and the time limit, and no destination or session", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    await runTool(h, "query", { sql: SQL })
    const run = one(callsOf(h.bigquery, "run"))[0] as Record<string, unknown>
    expect(run.jobId).toBe("oc_00000000-0000-4000-8000-000000000001")
    expect(run.maximumBytesBilled).toBe(10 * 2 ** 30)
    expect(run.jobTimeoutMs).toBe(600_000)
    expect(run.labels).toEqual({ oc_plugin: "opencode-bigquery", oc_tool: "bigquery_query", oc_session: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(run).not.toHaveProperty("destinationTable")
    expect(run).not.toHaveProperty("createSession")
    expect(run).not.toHaveProperty("connectionProperties")
    expect(run).not.toHaveProperty("writeDisposition")
  })

  it("asserts every referenced table as a resource after the fence (review M-2)", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    const { asserted } = await runTool(h, "query", { sql: SQL })
    const tableAssert = asserted.find((request) => request.action === "bigquery.query" && request.resources.includes("default:table:invented-proj.sales.orders"))
    expect(tableAssert).toBeDefined()
  })

  it("stops before the run when a person's rule denies the table resource (review M-2)", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    await expect(runTool(h, "query", { sql: SQL }, { deny: (request) => request.resources.some((resource) => resource.includes(":table:")) })).rejects.toThrow("denied by the rules")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("refuses a region-level INFORMATION_SCHEMA view under an allow fence, and allows it under a deny-only one (review LOW 1)", async () => {
    const fenced = harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { allow: [`${PROJECT}.sales`] } } } })
    scriptNativeRead(fenced.bigquery)
    const refused = await runTool(fenced, "query", { sql: "SELECT * FROM `region-us`.INFORMATION_SCHEMA.TABLES" })
    expect(refused.output).toMatchObject({ state: "refused", error: "DATASET_FENCED" })
    expect(fenced.bigquery.calls).toEqual([])

    const denied = harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { deny: [`${PROJECT}.private`] } } } })
    scriptNativeRead(denied.bigquery)
    expect((await runTool(denied, "query", { sql: "SELECT * FROM `region-us`.INFORMATION_SCHEMA.TABLES" })).output).toMatchObject({ state: "done" })

    // A dataset-qualified view inside the fence is allowed.
    const inside = harness(undefined, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { allow: [`${PROJECT}.sales`] } } } })
    scriptNativeRead(inside.bigquery)
    expect((await runTool(inside, "query", { sql: "SELECT * FROM `invented-proj`.sales.INFORMATION_SCHEMA.COLUMNS" })).output).toMatchObject({ state: "done" })
  })

  it("reports Google's cacheHit only, never an inference from 0 bytes billed (review LOW 3)", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { status: jobStatus({ totalBytesBilled: 0, cacheHit: undefined }) })
    expect((await runTool(h, "query", { sql: SQL })).output.cacheHit).toBe(false)
  })

  it("pins the run to the location the dry run chose", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    h.bigquery.on("dryRun", async () => ({ location: "europe-west2", statistics: statistics() }))
    await runTool(h, "query", { sql: SQL })
    expect(one(callsOf(h.bigquery, "run"))[0]).toMatchObject({ location: "europe-west2" })
  })

  it("answers running with the job and a next step when the page is not complete", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { page: { complete: false, rows: [] }, status: jobStatus({ state: "RUNNING" }) })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output).toMatchObject({ state: "running", job: { jobId: expect.any(String), location: "US" } })
    expect(String(output.next)).toContain("bigquery_job")
    expect(String(output.next)).toContain("wait: 30")
  })

  it("shapes rows with the schema's types, and cuts a cell at 200 characters", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, {
      page: resultPage({ schema: [{ name: "id", type: "INT64" }, { name: "note", type: "STRING" }], rows: [{ f: [{ v: "1" }, { v: "x".repeat(300) }] }], totalRows: 1 }),
    })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output.columns).toEqual([{ name: "id", type: "INT64" }, { name: "note", type: "STRING" }])
    const row = (output.rows as unknown[][])[0]!
    expect(row[0]).toBe(1)
    expect(String(row[1])).toHaveLength(200)
    expect(output.truncated).toEqual({ rows: false, cells: true, bytes: false })
  })

  it("truncates rows exactly: it asks for maxRows + 1 and returns the first maxRows", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { page: resultPage({ rows: [1, 2, 3].map((value) => ({ f: [{ v: String(value) }] })), totalRows: 3 }) })
    const { output } = await runTool(h, "query", { sql: SQL, maxRows: 2 })
    expect(one(callsOf(h.bigquery, "results"))[2]).toMatchObject({ maxResults: 3 })
    expect(output.returned).toBe(2)
    expect(output.truncated).toMatchObject({ rows: true })
  })

  it("passes wait through as the long-poll, in milliseconds", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    await runTool(h, "query", { sql: SQL, wait: 5 })
    expect(one(callsOf(h.bigquery, "results"))[2]).toMatchObject({ timeoutMs: 5_000 })
  })
})

describe("the query tool's cap and budget", () => {
  it("answers COST_CAP with the estimate and the cap, and runs nothing", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { statistics: statistics({ totalBytesProcessed: String(20 * 2 ** 30) }) })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output).toMatchObject({ state: "refused", error: "COST_CAP" })
    expect(String(output.message)).toContain("21474836480")
    expect(String(output.message)).toContain(String(10 * 2 ** 30))
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("refuses maxBytes above the ceiling rather than silently lowering it", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    const { output } = await runTool(h, "query", { sql: SQL, maxBytes: "200GiB" })
    expect(output).toMatchObject({ error: "INPUT_INVALID" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("answers BYTES_BILLED_LIMIT when Google stops the job at the cap, and records no spend", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { status: jobStatus({ totalBytesBilled: 0, error: { reason: "bytesBilledLimitExceeded", message: "stopped" } }) })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output).toMatchObject({ state: "failed", error: "BYTES_BILLED_LIMIT" })
    expect(output.googleError).toMatchObject({ reason: "bytesBilledLimitExceeded", trust: "untrusted" })
    expect(h.ledger.entries).toEqual([])
  })

  it("records the actual bytes billed in the ledger, under the tool's name and a hashed session", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery)
    await runTool(h, "query", { sql: SQL })
    expect(h.ledger.entries).toHaveLength(1)
    expect(h.ledger.entries[0]).toMatchObject({ account: "default", bytesBilled: 1048576, via: "bigquery_query", project: "invented-proj", location: "US" })
    expect(h.ledger.entries[0]!.session).toMatch(/^[0-9a-f]{16}$/)
    expect(h.ledger.entries[0]!.session).not.toBe("ses_reads_1")
  })

  it("answers BUDGET_REACHED before the dry run when the budget is spent, and BUDGET_WARN when the action is warn", async () => {
    const spent = { at: new Date().toISOString(), account: "default", project: "invented-proj", location: "US", jobId: "oc_earlier", bytesBilled: 5_000, via: "bigquery_query", session: "abcdefabcdefabcd" }
    const refusing = harness(undefined, { budget: { daily: 1_000, action: "refuse" } })
    refusing.ledger.entries.push(spent)
    scriptNativeRead(refusing.bigquery)
    const stopped = await runTool(refusing, "query", { sql: SQL })
    expect(stopped.output).toMatchObject({ state: "refused", error: "BUDGET_REACHED" })
    expect(callsOf(refusing.bigquery, "run")).toEqual([])

    const warning = harness(undefined, { budget: { daily: 1_000, action: "warn" } })
    warning.ledger.entries.push(spent)
    scriptNativeRead(warning.bigquery)
    const ran = await runTool(warning, "query", { sql: SQL })
    expect(ran.output).toMatchObject({ state: "done" })
    expect((ran.output.warnings as { code: string }[]).map((item) => item.code)).toContain("BUDGET_WARN")
  })

  it("counts a previous job against today's budget: the cap is what the budget leaves", async () => {
    const h = harness(undefined, { budget: { daily: 10 * 2 ** 30 + 2 * 2 ** 30, action: "refuse" } })
    h.ledger.entries.push({ at: new Date().toISOString(), account: "default", project: "invented-proj", location: "US", jobId: "oc_earlier", bytesBilled: 10 * 2 ** 30, via: "bigquery_query", session: "abcdefabcdefabcd" })
    scriptNativeRead(h.bigquery)
    await runTool(h, "query", { sql: SQL })
    expect(one(callsOf(h.bigquery, "run"))[0]).toMatchObject({ maximumBytesBilled: 2 * 2 ** 30 })
  })
})

describe("a read the cap cannot bound", () => {
  it("answers NEEDS_PLAN with CAP_NOT_ENFORCEABLE and runs nothing", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { statistics: statistics({ totalBytesProcessedAccuracy: "LOWER_BOUND" }) })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(needsPlan(output)).toBe("CAP_NOT_ENFORCEABLE")
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("answers CAP_NOT_ENFORCEABLE when uncappedReads is refuse", async () => {
    const h = harness(undefined, { uncappedReads: "refuse" })
    scriptNativeRead(h.bigquery, { statistics: statistics({ totalBytesProcessedAccuracy: "LOWER_BOUND" }) })
    const { output } = await runTool(h, "query", { sql: SQL })
    expect(output).toMatchObject({ state: "refused", error: "CAP_NOT_ENFORCEABLE" })
    expect(callsOf(h.bigquery, "run")).toEqual([])
  })

  it("runs an uncapped-read plan only after bigquery.uncapped_read, with the 120 s limit and the plan's cap", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { statistics: statistics({ totalBytesProcessedAccuracy: "LOWER_BOUND" }) })
    const plan = h.ports.plans.create({
      category: "uncapped-read",
      account: "default",
      sessionId: "ses_reads_1",
      agentId: "build",
      committable: true,
      statement: { sql: SQL, project: "invented-proj", location: "US", statementType: "SELECT", targets: [], estimateBytes: 1048576, capBytes: 2 * 2 ** 30, capEnforceable: false, jobTimeoutSeconds: 300 },
      preview: { category: "uncapped-read", statementType: "SELECT", targets: [], referenced: [], bytes: 1048576, accuracy: "LOWER_BOUND", usd: 0, capBytes: 2 * 2 ** 30, bound: "The cap may not bound this query" },
      ttlSeconds: 300,
    })
    const { output, asserted } = await runTool(h, "query", { planId: plan.id })
    expect(output).toMatchObject({ state: "done" })
    expect(asserted.filter((request) => request.action === ASKS.uncappedRead)).toHaveLength(1)
    const run = one(callsOf(h.bigquery, "run"))[0]
    expect(run).toMatchObject({ maximumBytesBilled: 2 * 2 ** 30, jobTimeoutMs: 120_000 })
    expect(h.ports.plans.get(plan.id)?.state).toBe("consumed")
  })

  it("runs a plan on a Read and write account too: the cap, not the level, is what an uncapped read needs", async () => {
    const h = harness(signedIn())
    scriptNativeRead(h.bigquery, { statistics: statistics({ totalBytesProcessedAccuracy: "LOWER_BOUND" }) })
    const plan = h.ports.plans.create({
      category: "uncapped-read",
      account: "default",
      sessionId: "ses_reads_1",
      agentId: "build",
      committable: true,
      statement: { sql: SQL, project: "invented-proj", location: "US", statementType: "SELECT", targets: [], estimateBytes: 1048576, capBytes: 2 ** 30, capEnforceable: false, jobTimeoutSeconds: 300 },
      preview: { category: "uncapped-read", statementType: "SELECT", targets: [], referenced: [], bytes: 1048576, accuracy: "LOWER_BOUND", usd: 0, capBytes: 2 ** 30, bound: "The cap may not bound this query" },
      ttlSeconds: 300,
    })
    expect((await runTool(h, "query", { planId: plan.id })).output).toMatchObject({ state: "done" })
  })

  it("runs nothing when the person denies the ask, and the plan is gone", async () => {
    const h = harness()
    scriptNativeRead(h.bigquery, { statistics: statistics({ totalBytesProcessedAccuracy: "LOWER_BOUND" }) })
    const plan = h.ports.plans.create({
      category: "uncapped-read",
      account: "default",
      sessionId: "ses_reads_1",
      agentId: "build",
      committable: true,
      statement: { sql: SQL, project: "invented-proj", location: "US", statementType: "SELECT", targets: [], estimateBytes: 1048576, capBytes: 2 ** 30, capEnforceable: false, jobTimeoutSeconds: 300 },
      preview: { category: "uncapped-read", statementType: "SELECT", targets: [], referenced: [], bytes: 1048576, accuracy: "LOWER_BOUND", usd: 0, capBytes: 2 ** 30, bound: "The cap may not bound this query" },
      ttlSeconds: 300,
    })
    await expect(runTool(h, "query", { planId: plan.id }, { deny: (request) => request.action === ASKS.uncappedRead })).rejects.toThrow("denied by the rules")
    expect(h.bigquery.calls).toEqual([])
    expect(h.ports.plans.get(plan.id)?.state).toBe("expired")
  })

  it("refuses an uncapped-read plan from a script before anything else (the registry's rule)", async () => {
    const h = harness()
    const plan = h.ports.plans.create({
      category: "uncapped-read",
      account: "default",
      sessionId: "ses_reads_1",
      agentId: "build",
      committable: true,
      statement: { sql: SQL, project: "invented-proj", location: "US", statementType: "SELECT", targets: [], estimateBytes: 1, capBytes: 1, capEnforceable: false, jobTimeoutSeconds: 300 },
      preview: { category: "uncapped-read", statementType: "SELECT", targets: [], referenced: [], bytes: 1, accuracy: "LOWER_BOUND", usd: 0, capBytes: 1, bound: "The cap may not bound this query" },
      ttlSeconds: 300,
    })
    await expect(runTool(h, "query", { planId: plan.id }, { via: "rpc" })).rejects.toThrow(/PERMISSION_DENIED/)
    expect(h.bigquery.calls).toEqual([])
  })
})
