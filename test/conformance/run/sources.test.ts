// The source contract's conformance kit over both sources `package.json` declares (design §10, §15): the declaration,
// `bigquery.jobs`' pages, the `bigquery.saved` snapshot, `probe` and the bind-time `saved_list`, run through the
// plugin's own specs against invented Google answers — no Google call. The report is written to
// reports/conformance-report.json, which the release workflow's conformance job reads (`scripts/release-rules.mjs`).
//
// Every check either runs or does not apply. `bigquery.jobs` declares `atomicPages` (one window's `jobs.list` pages, or
// nothing) and does **not** declare `noExpiry`: BigQuery keeps job history six months, so the expired-cursor check runs.
//
// Two contract requests are visible here, both in this pull request's description:
// - the kit's `billed-cost` check cannot apply to a billed *snapshot* (it is neither an events source nor a non-billed
//   one), so the snapshot is checked under the same price table with class `metered`, the family's precedent; the
//   declaration itself stays `billed` and is validated by test/conformance/declaration.test.ts;
// - `probe` and `saved_list` receive `{ source, account }` from the contract's reader, but Day 0's `ProbeInput` and
//   `SavedListInput` are strict and do not accept `source`; the adapter drops it, and the request asks for the field.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { SOURCES_SCHEMA } from "@we-the-rebel-alliance/source-contract/schema"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  assertConformance,
  declarationProblems,
  sourceConformance,
  type ConformanceReport,
  type PageCase,
  type SessionContext,
  type ToolDeclaration,
} from "@we-the-rebel-alliance/source-contract/conformance"
import { TOOLS_RPC_ID } from "../../../src/host/script-methods.js"
import { bindingOf } from "../../../src/sources/cursor.js"
import { probeSource, type SourceDeps } from "../../../src/sources/index.js"
import { loadOptions } from "../../../src/options.js"
import { toolSpecs } from "../../../src/registry.js"
import { fakePorts, readRecord } from "../../fake/ports.js"
import { job, jobStatus, nativeRead, PROJECT, resultPage, serveJobs, statistics, type JobFixture } from "../../unit/sources/support.js"

const ROOT = join(import.meta.dir, "..", "..", "..")
const NOW = Date.parse("2026-11-17T12:00:00Z")
const HOUR = 3_600_000
const DAY = 86_400_000
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; version: string; sources: unknown }

const checked = SOURCES_SCHEMA.check(pkg.sources)
if (!checked.ok) throw new Error(`the sources declaration is invalid: ${checked.problems.join("; ")}`)
const sources = checked.value

const options = loadOptions({
  accounts: { work: { billingProject: PROJECT, location: "US" } },
  savedQueries: { revenue: { sql: "SELECT id, amount FROM sales.orders" } },
})
const ports = fakePorts({ work: { mode: "interactive", record: readRecord({ email: "ada@example.invalid" }), email: "ada@example.invalid", refreshScopes: [] } })
const specs = toolSpecs(options, ports)
const tools: ToolDeclaration[] = specs.filter((spec) => spec.class === "read" && spec.readOnly).map((spec) => ({ id: spec.name, readOnly: true }))

/** A call bound to the kit's session permission, as the tools RPC binds a script's call. */
function callFor(context: SessionContext) {
  return {
    sessionID: "ses_conformance",
    agent: "build",
    messageID: "msg_conformance",
    id: "call_conformance",
    signal: new AbortController().signal,
    via: "rpc" as const,
    assert: (request: { action: string; resources?: readonly string[] }) => context.permission.assert({ action: request.action, resources: [...(request.resources ?? ["*"])] }),
  }
}

/** The dependencies a source function reads with, bound to the kit's session and its account. */
function depsFor(context: SessionContext, account: string): SourceDeps {
  return { ports, options, account, call: callFor(context) as never }
}

/** Run one of the plugin's specs the way a script's tools RPC call does, under the kit's permission. */
async function run(context: SessionContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  const spec = specs.find((candidate) => candidate.name === name)
  if (!spec) throw new Error(`no spec named ${name}`)
  const outcome = await spec.run(input as never, callFor(context) as never)
  return outcome.output
}

/** The three recent jobs, one with a secret-shaped statement type, and a day of bulk for the truncation case. */
const secret = "deploy ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const bulk: JobFixture[] = Array.from({ length: 1_005 }, (_, index) =>
  job({ jobId: `bulk-${String(index).padStart(4, "0")}`, created: NOW - 23 * HOUR + index * 68_000, ended: NOW - 23 * HOUR + index * 68_000 + 60_000, bytesBilled: 1_048_576 }),
)
const recent: JobFixture[] = [
  job({ jobId: "job-select", created: NOW - 3 * HOUR, ended: NOW - 3 * HOUR + 60_000, statementType: "SELECT", labels: { oc_tool: "bigquery_query" } }),
  job({ jobId: "job-insert", created: NOW - 2 * HOUR, ended: NOW - 2 * HOUR + 30_000, statementType: "INSERT", bytesBilled: 0 }),
  job({ jobId: "job-secret", created: NOW - 90 * 60_000, ended: NOW - 89 * 60_000, statementType: secret }),
]
serveJobs(ports.bigquery, [...bulk, ...recent])
ports.bigquery.on("estimate", async (request: { sql: string }) => ({ statementType: "SELECT", totalBytesProcessed: request.sql.includes("orders") ? 2 ** 30 : 0 }))
nativeRead(ports.bigquery, {
  statistics: statistics({ referencedTables: [], totalBytesProcessed: "1048576" }),
  page: resultPage({ schema: [{ name: "id", type: "INT64" }, { name: "amount", type: "FLOAT64" }], rows: [{ f: [{ v: "1" }, { v: "2.5" }] }], totalRows: 1 }),
  status: jobStatus({ ref: { projectId: PROJECT, jobId: "saved-job", location: "US" } }),
})

const iso = (ms: number) => new Date(ms).toISOString()
const cases: PageCase[] = [
  { name: "the last three hours, with a secret-shaped title refused", input: { source: "jobs", account: "work", since: iso(NOW - 3 * HOUR) }, expect: "page" },
  { name: "nothing since the last listing", input: { source: "jobs", account: "work", since: iso(NOW - 10 * 60_000) }, expect: "empty" },
  { name: "a cursor older than the six months BigQuery keeps", input: { source: "jobs", account: "work", cursor: encodeBoundCursor(bindingOf("work", undefined), { w: NOW - 181 * DAY, f: NOW - 182 * DAY, e: NOW - 181 * DAY }) }, expect: "expired" },
  { name: "another account's cursor", input: { source: "jobs", account: "work", cursor: encodeBoundCursor(bindingOf("other", undefined), { w: NOW, f: NOW - HOUR, e: NOW }) }, expect: { refuses: "CURSOR_INVALID" } },
  { name: "another plugin's cursor", input: { source: "jobs", account: "work", cursor: encodeBoundCursor({ plugin: "other-plugin", source: "jobs", account: "work" }, { w: NOW, f: NOW - HOUR, e: NOW }) }, expect: { refuses: "CURSOR_INVALID" } },
  { name: "a confirmed scope", input: { source: "jobs", account: "work", since: iso(NOW - 3 * HOUR), scope: { projects: ["invented-proj"] } }, expect: "page" },
  { name: "a day of jobs, more than ten listings carry", input: { source: "jobs", account: "work", since: iso(NOW - 24 * HOUR), limit: 100 }, expect: "page" },
]

const reports: ConformanceReport[] = []

describe("the source contract's conformance kit", () => {
  test("the declaration validates as a consumer reads it", () => {
    expect(declarationProblems(pkg.sources, { tools })).toEqual([])
    const declared = pkg.sources as { rpc: string; items: { id: string }[] }
    expect(declared.rpc).toBe(TOOLS_RPC_ID)
    expect(declared.items.map((item) => item.id)).toEqual(["bigquery.jobs", "bigquery.saved"])
  })

  for (const source of sources.items) {
    test(`${source.id} keeps the contract`, async () => {
      const events = source.id === "bigquery.jobs"
      // The kit's `billed-cost` check cannot mark a billed snapshot "not applicable" (see the header); `metered` is the
      // same price table and the shape the kit can check. The declaration is unchanged and validated above.
      const underTest = !events && source.cost.class === "billed" ? { ...source, cost: { ...source.cost, class: "metered" as const } } : source
      const grants = events
        ? [
            { action: "bigquery.events_list", resource: "*" },
            { action: "bigquery.events_list", resource: "{account}:bigquery.jobs.list" },
            { action: "bigquery.probe", resource: "*" },
          ]
        : [
            { action: "bigquery.saved_read", resource: "*" },
            ...[
              "bigquery.jobs.getQueryResults",
              "bigquery.jobs.query",
              "bigquery.routines.get",
              "bigquery.rowAccessPolicies.list",
              "bigquery.tabledata.list",
              "bigquery.tables.get",
            ].map((operation) => ({ action: "bigquery.saved_read", resource: `{account}:${operation}` })),
            { action: "bigquery.probe", resource: "*" },
          ]
      const report = await sourceConformance({
        plugin: "google-cloud.bigquery",
        source: underTest as typeof source,
        tools,
        account: "work",
        grants,
        sources: { rpc: (pkg.sources as { rpc: string }).rpc, probe: (pkg.sources as { probe: { action: string } }).probe },
        describe: { id: TOOLS_RPC_ID },
        atomicPages: {
          reason: "a page is built from complete jobs.list listings of one creation-time window, or not at all: a failed call fails the whole events_list, so no single job can fail on its own",
        },
        calls: {
          list: (input, context) => run(context, "events_list", input as Record<string, unknown>),
          // The contract's reader calls probe with `{ source, account }`; Day 0's `ProbeInput` refuses `source` (a
          // contract request), so the adapter asserts the probe action as the registry does and calls the source itself.
          probe: async (input, context) => {
            await context.permission.assert({ action: "bigquery.probe", resources: ["*"] })
            return probeSource(depsFor(context, "work"), input)
          },
          // The kit's bind grant for a suggest operation is `<namespace>.read` on `<account>:<operation>`; Day 0's
          // action table has no `bigquery.read` to assert it with (a contract request). The adapter records that grant's
          // assert, then runs the method, whose own assert is the `saved_list` action on the same operation.
          suggest: async (input, context) => {
            await context.permission.assert({ action: "bigquery.read", resources: ["work:bigquery.jobs.queryEstimate"] })
            return run(context, "saved_list", { account: String((input as { account?: string }).account ?? "work") })
          },
          snapshot: (input, context) => run(context, "saved_read", { source: "saved", account: "work", name: String((input as { name?: string }).name ?? "revenue") }),
        },
        cases: events ? cases : [],
        snapshotCases: events ? [] : [{ name: "revenue" }],
      })
      assertConformance(report)
      reports.push(report)
      expect(report.ok).toBe(true)
      expect(report.incomplete).toBe(false)
      for (const check of report.checks) expect(check.ran || check.notApplicable, `${check.name}: ${check.problems.join("; ")}`).toBe(true)
    })
  }

  test("the report is written for the release job", () => {
    const report = {
      ok: reports.length === 2 && reports.every((entry) => entry.ok),
      plugin: pkg.name,
      version: pkg.version,
      contract: { package: "@we-the-rebel-alliance/source-contract", tag: "v0.2.0" },
      sources: reports,
    }
    mkdirSync(join(ROOT, "reports"), { recursive: true })
    writeFileSync(join(ROOT, "reports", "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`)
    expect(report.ok).toBe(true)
  })
})
