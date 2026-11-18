// The `bigquery.saved` snapshot and its `saved_list` and `probe` (design §10), against invented Google answers: the
// read path is package C's, so these tests prove the source's own rules — the query it may read, the table it answers,
// the size it refuses, and the estimates the bind step shows.
import { describe, expect, test } from "vitest"
import type { SchemaField } from "../../../src/domain/google.js"
import { harness, nativeRead, nativeTable, resultPage, runTool, statistics } from "./support.js"

const NOW_ISO = "2026-11-17T12:00:00.000Z"

const columns = (count: number): SchemaField[] => Array.from({ length: count }, (_, index) => ({ name: `col_${index + 1}`, type: "INT64" }))
const rawRows = (count: number): { f: { v: string }[] }[] => Array.from({ length: count }, (_, index) => ({ f: [{ v: String(index) }] }))

describe("bigquery.saved", () => {
  test("reads a saved query through the read path and answers the registry's table", async () => {
    const target = harness({ savedQueries: { revenue: { sql: "SELECT id, amount FROM sales.orders" } } })
    nativeRead(target.bigquery, {
      page: resultPage({
        schema: [{ name: "id", type: "INT64" }, { name: "amount", type: "FLOAT64" }],
        rows: [
          { f: [{ v: "1" }, { v: "2.50" }] },
          { f: [{ v: "2" }, { v: null }] },
        ],
        totalRows: 2,
      }),
    })
    const { output, asserted } = await runTool(target, "saved_read", { source: "saved", name: "revenue" })
    expect(output["state"]).toBeUndefined()
    expect(output["data"]).toEqual({
      columns: [
        { key: "c1", label: "id" },
        { key: "c2", label: "amount" },
      ],
      rows: [{ c1: 1, c2: 2.5 }, { c1: 2, c2: null }],
    })
    expect(output["asOf"]).toBe(NOW_ISO)
    expect(output["trust"]).toBe("untrusted")
    expect(output["cost"]).toEqual({ units: [{ per: "tib", count: 0 }], usd: 1048576 / 2 ** 40 * 6.25 })
    // The registry asserts the method's own action on its operation first; the source then asserts the contract's
    // `bigquery.read` on every operation its descriptor declares, before the read's first call, then the table it reads
    // (§5.4's per-object assert, through the method's action).
    const operations = asserted.filter((request) => request.action === "bigquery.saved_read").map((request) => request.resources[0])
    expect(operations[0]).toBe("default:bigquery.jobs.query")
    expect(asserted.filter((request) => request.action === "bigquery.read").map((request) => request.resources[0])).toEqual([
      "default:bigquery.jobs.getQueryResults",
      "default:bigquery.jobs.query",
      "default:bigquery.routines.get",
      "default:bigquery.rowAccessPolicies.list",
      "default:bigquery.tabledata.list",
      "default:bigquery.tables.get",
    ])
    expect(operations).toContain("default:table:invented-proj.sales.orders")
  })

  test("refuses an unknown saved query, and a query whose cost the cap cannot bound", async () => {
    const target = harness({ savedQueries: { big: { sql: "SELECT * FROM sales.orders" } } })
    const unknown = await runTool(target, "saved_read", { source: "saved", name: "missing" })
    expect(unknown.output["error"]).toBe("INPUT_INVALID")
    nativeRead(target.bigquery, { statistics: statistics({ totalBytesProcessedAccuracy: "LOWER_BOUND" }) })
    const unbounded = await runTool(target, "saved_read", { source: "saved", name: "big" })
    expect(unbounded.output["error"]).toBe("INPUT_INVALID")
    expect(String(unbounded.output["message"])).toContain("lower bound")
  })

  test("a non-cacheable query needs allowUncached, because every read of it bills", async () => {
    const target = harness({
      savedQueries: {
        clock: { sql: "SELECT CURRENT_TIMESTAMP() AS at" },
        clock_allowed: { sql: "SELECT CURRENT_TIMESTAMP() AS at", allowUncached: true },
      },
    })
    const refused = await runTool(target, "saved_read", { source: "saved", name: "clock" })
    expect(refused.output["error"]).toBe("INPUT_INVALID")
    expect(String(refused.output["message"])).toContain("cannot cache")
    expect(target.bigquery.calls.filter((entry) => entry.method === "dryRun")).toEqual([])
    nativeRead(target.bigquery, { statistics: statistics({ referencedTables: [], totalBytesProcessed: "0" }), page: resultPage({ schema: [{ name: "at", type: "TIMESTAMP" }], rows: [{ f: [{ v: "1700000000" }] }], totalRows: 1 }) })
    const allowed = await runTool(target, "saved_read", { source: "saved", name: "clock_allowed" })
    expect(allowed.output["data"]).toEqual({ columns: [{ key: "c1", label: "at" }], rows: [{ c1: "2023-11-14T22:13:20.000Z" }] })
  })

  test("more than eight columns or more than a hundred rows is TOO_LARGE, never a silent cut", async () => {
    const many = harness({ savedQueries: { wide: { sql: "SELECT * FROM sales.wide" } } })
    nativeRead(many.bigquery, { page: resultPage({ schema: columns(9), rows: [], totalRows: 0 }) })
    const wide = await runTool(many, "saved_read", { source: "saved", name: "wide" })
    expect(wide.output["error"]).toBe("TOO_LARGE")

    const long = harness({ savedQueries: { long: { sql: "SELECT id FROM sales.orders" } } })
    nativeRead(long.bigquery, { page: resultPage({ schema: [{ name: "id", type: "INT64" }], rows: rawRows(101), totalRows: 101 }) })
    const manyRows = await runTool(long, "saved_read", { source: "saved", name: "long" })
    expect(manyRows.output["error"]).toBe("TOO_LARGE")
  })

  test("a policy-tagged result is refused: a source answers rows, and the rule keeps them out of one", async () => {
    const target = harness({ savedQueries: { tagged: { sql: "SELECT * FROM sales.patients" } } })
    nativeRead(target.bigquery, { table: nativeTable({ schema: { fields: [{ name: "ssn", type: "STRING", policyTags: { names: ["policyTags/p1"] } }] } }) })
    const answer = await runTool(target, "saved_read", { source: "saved", name: "tagged" })
    expect(answer.output["error"]).toBe("INPUT_INVALID")
    expect(String(answer.output["message"])).toContain("policy-tagged")
  })

  test("saved_list names every query, with its SQL and a free jobs.query estimate", async () => {
    const target = harness({
      savedQueries: {
        revenue: { sql: "SELECT id FROM sales.orders" },
        broken: { sql: "SELECT * FROM" },
      },
    })
    const { BigQueryError } = await import("../../../src/domain/errors.js")
    target.bigquery.on("estimate", async (request: { sql: string }) => {
      if (request.sql === "SELECT * FROM") throw new BigQueryError("SQL_INVALID", "Google rejected the dry run")
      return { statementType: "SELECT", totalBytesProcessed: 2 ** 30 }
    })
    const { output } = await runTool(target, "saved_list", {})
    expect(output["options"]).toEqual([
      { id: "revenue", label: "revenue: SELECT id FROM sales.orders" },
      { id: "broken", label: "broken: SELECT * FROM" },
    ])
    expect(output["queries"]).toEqual([
      { name: "revenue", sql: "SELECT id FROM sales.orders", bytes: 2 ** 30, costUsd: (2 ** 30 / 2 ** 40) * 6.25 },
      { name: "broken", sql: "SELECT * FROM" },
    ])
    expect(target.bigquery.calls.filter((entry) => entry.method === "estimate")).toHaveLength(2)
  })

  test("probe names the signed-in address, or the account when Google reports none", async () => {
    const signedIn = harness()
    const first = await runTool(signedIn, "probe", {})
    expect(first.output).toMatchObject({ source: "jobs", account: "default", owner: { id: "mailto:ada@example.invalid" }, trust: "untrusted" })
    expect(first.output["owner"]).not.toHaveProperty("verified")

    const token = harness(
      {},
      { mode: "token", refreshScopes: [] },
    )
    // A token account's identity is unknown without Google: the owner is the account, not an invented address.
    const second = await runTool(token, "probe", {})
    expect(second.output["owner"]).toEqual({ id: "bigquery:account:default", label: "BigQuery account default" })
    expect(token.bigquery.calls).toEqual([])
  })

  test("a probe and a saved read assert their own action before any call", async () => {
    const target = harness({ savedQueries: { revenue: { sql: "SELECT id FROM sales.orders" } } })
    nativeRead(target.bigquery)
    const probe = await runTool(target, "probe", {})
    expect(probe.asserted[0]).toMatchObject({ action: "bigquery.probe", resources: ["*"] })
    const read = await runTool(target, "saved_read", { source: "saved", name: "revenue" })
    expect(read.asserted[0]).toMatchObject({ action: "bigquery.saved_read", resources: ["default:bigquery.jobs.query"] })
  })
})

describe("the sources' tools RPC methods, called as a consumer calls them", () => {
  // The contract's reader (`read`, `probe`, the bind step's suggest) sends the item's `input.source`, the account, and
  // for a read the confirmed scope (docs/contract.md L2). `scriptMethod` parses each input strictly, as the tools RPC
  // does, so these are the real path.
  const methodOf = async (target: ReturnType<typeof harness>, name: string) => {
    const { scriptMethod } = await import("../../../src/tool-spec.js")
    const asserted: { action: string; resources: string[] }[] = []
    const method = scriptMethod(target.spec(name), async (request) => {
      asserted.push({ action: request.action, resources: request.resources })
    })
    const identity = { sessionID: "ses_rpc", agent: "build", messageID: "msg_rpc", id: "call_rpc", signal: new AbortController().signal }
    const { SCHEMAS } = await import("../../../src/domain/contract.js")
    const output = SCHEMAS[name as keyof typeof SCHEMAS].output
    // The tools RPC checks every answer against the method's declared output, so these runs do too.
    const run = async (input: unknown) => {
      const answer = (await method.run(input as never, identity as never)) as Record<string, unknown>
      const checked = output.safeParse(answer)
      if (!checked.success) throw new Error(`${name}'s answer breaks its declared output: ${checked.error.message}`)
      return answer
    }
    return { asserted, run }
  }

  test("probe takes { source, account } for either source, by its short name or its id, and names it back", async () => {
    const target = harness()
    const probe = await methodOf(target, "probe")
    for (const [source, named] of [["jobs", "jobs"], ["saved", "saved"], ["bigquery.jobs", "jobs"], ["bigquery.saved", "saved"]] as const) {
      expect(await probe.run({ source, account: "default" })).toMatchObject({ source: named, account: "default", owner: { id: "mailto:ada@example.invalid" } })
    }
    expect(await probe.run({ account: "default" })).toMatchObject({ source: "jobs" })
    await expect(probe.run({ source: "elsewhere", account: "default" })).rejects.toThrow(/INPUT_INVALID/)
    expect(target.bigquery.calls).toEqual([])
  })

  test("saved_list takes the kit's { source: bigquery.saved, account } and asserts bigquery.read on the estimate", async () => {
    const target = harness({ savedQueries: { revenue: { sql: "SELECT id FROM sales.orders" } } })
    target.bigquery.on("estimate", async () => ({ statementType: "SELECT", totalBytesProcessed: 1024 }))
    const list = await methodOf(target, "saved_list")
    const answer = await list.run({ source: "bigquery.saved", account: "default" })
    expect(answer["options"]).toEqual([{ id: "revenue", label: "revenue: SELECT id FROM sales.orders" }])
    expect(list.asserted).toEqual([
      { action: "bigquery.saved_list", resources: ["default:bigquery.jobs.queryEstimate"] },
      { action: "bigquery.read", resources: ["default:bigquery.jobs.queryEstimate"] },
    ])
  })

  test("saved_read takes { source, account, scope, name }, and refuses a name outside the confirmed queries", async () => {
    const target = harness({ savedQueries: { revenue: { sql: "SELECT id, amount FROM sales.orders" }, other: { sql: "SELECT 1" } } })
    nativeRead(target.bigquery)
    const read = await methodOf(target, "saved_read")
    const answer = await read.run({ source: "saved", account: "default", scope: { queries: ["revenue"] }, name: "revenue" })
    expect(answer["data"]).toBeDefined()
    const calls = target.bigquery.calls.length
    await expect(read.run({ source: "saved", account: "default", scope: { queries: ["revenue"] }, name: "other" })).rejects.toThrow(/INPUT_INVALID/)
    expect(target.bigquery.calls.length).toBe(calls)
  })

  test("events_list takes { source, account, scope, since, limit } as the reader sends it", async () => {
    const { serveJobs, job } = await import("./support.js")
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: Date.parse("2026-11-17T11:00:00Z"), ended: Date.parse("2026-11-17T11:30:00Z") })])
    const list = await methodOf(target, "events_list")
    const answer = await list.run({ source: "jobs", account: "default", scope: { projects: ["invented-proj"] }, since: "2026-11-17T10:00:00Z", limit: 10 })
    expect((answer["events"] as unknown[]).length).toBe(1)
    expect(list.asserted.map((request) => request.action)).toEqual(["bigquery.events_list", "bigquery.read"])
  })
})
