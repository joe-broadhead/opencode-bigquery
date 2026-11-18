// The source contract's conformance kit over both sources `package.json` declares (design §10, §15): the declaration,
// `bigquery.jobs`' pages, the `bigquery.saved` snapshot, `probe` and the bind-time `saved_list`, against invented Google
// answers — no Google call. The report is written to reports/conformance-report.json, which the release workflow's
// conformance job reads (`scripts/release-rules.mjs`).
//
// The kit runs under the grants a real consumer makes: it derives them itself from the declaration
// (`permission.sessionRules`, the probe's and the bind step's rules), so no grant here is written by hand, and every
// call goes through the tools RPC's method path (`scriptMethod`: the strict input check, the registry's assert, the
// source's own `bigquery.read` asserts) with the inputs the contract's reader sends: `{ source, account }` to probe and
// the suggest tool, `{ source, account, scope, name }` to the snapshot.
//
// Every check either runs or does not apply. `bigquery.jobs` declares `atomicPages` (a page is built from complete
// `jobs.list` answers, or not at all) and does **not** declare `noExpiry`: BigQuery keeps job history six months, so the
// expired-cursor check runs.
//
// One override is recorded in the report (`notes`): the kit's `billed-cost` check cannot apply to a billed *snapshot*
// (it is neither an events source nor a non-billed one), so the snapshot is checked under the same price table with
// class `metered`. The declaration itself stays `billed` and is validated by test/conformance/declaration.test.ts and
// by the first test below; the contract's fix is a v0.2.1 patch (review bigquery-9, ruling 3).
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
import { loadOptions } from "../../../src/options.js"
import { toolSpecs } from "../../../src/registry.js"
import { scriptMethod } from "../../../src/tool-spec.js"
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

/**
 * One of the plugin's methods, called the way the tools RPC calls it: the method's strict input check, then the spec,
 * with the host's assert being the kit's recording session permission.
 */
async function run(context: SessionContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  const spec = specs.find((candidate) => candidate.name === name)
  if (!spec) throw new Error(`no spec named ${name}`)
  const method = scriptMethod(spec, async (request) => {
    await context.permission.assert({ action: request.action, resources: [...request.resources] })
  })
  const identity = { sessionID: "ses_conformance", agent: "build", messageID: "msg_conformance", id: "call_conformance", signal: new AbortController().signal }
  return method.run(input as never, identity as never)
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
  { name: "a cursor older than the six months BigQuery keeps", input: { source: "jobs", account: "work", cursor: encodeBoundCursor(bindingOf("work", undefined), { e: NOW - 181 * DAY, f: NOW - 182 * DAY }) }, expect: "expired" },
  { name: "an expired cursor read one job a page, so the gap must not repeat", input: { source: "jobs", account: "work", limit: 1, cursor: encodeBoundCursor(bindingOf("work", undefined), { e: NOW - 181 * DAY, f: NOW - 182 * DAY }) }, expect: "expired" },
  { name: "another account's cursor", input: { source: "jobs", account: "work", cursor: encodeBoundCursor(bindingOf("other", undefined), { e: NOW, f: NOW - HOUR }) }, expect: { refuses: "CURSOR_INVALID" } },
  { name: "another plugin's cursor", input: { source: "jobs", account: "work", cursor: encodeBoundCursor({ plugin: "other-plugin", source: "jobs", account: "work" }, { e: NOW, f: NOW - HOUR }) }, expect: { refuses: "CURSOR_INVALID" } },
  { name: "a confirmed scope", input: { source: "jobs", account: "work", since: iso(NOW - 3 * HOUR), scope: { projects: ["invented-proj"] } }, expect: "page" },
  { name: "a day of jobs, more than one events_list call's walk", input: { source: "jobs", account: "work", since: iso(NOW - 24 * HOUR), limit: 100 }, expect: "page" },
  { name: "a day of jobs, one a page", input: { source: "jobs", account: "work", since: iso(NOW - 24 * HOUR), limit: 1 }, expect: "page" },
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
      const report = await sourceConformance({
        plugin: "google-cloud.bigquery",
        source: underTest as typeof source,
        tools,
        account: "work",
        sources: { rpc: (pkg.sources as { rpc: string }).rpc, probe: (pkg.sources as { probe: { action: string } }).probe },
        describe: { id: TOOLS_RPC_ID },
        ...(events
          ? {
              atomicPages: {
                reason: "a page is built from complete jobs.list answers, or not at all: any failed call fails the whole events_list and leaves the cursor where it was, so no single job can fail on its own",
              },
            }
          : {}),
        calls: {
          list: (input, context) => run(context, "events_list", input as Record<string, unknown>),
          probe: (input, context) => run(context, "probe", input as Record<string, unknown>),
          suggest: (input, context) => run(context, "saved_list", input as Record<string, unknown>),
          // The contract's reader sends the item's input, the account, the confirmed scope and the resolved params.
          snapshot: (input, context) => run(context, "saved_read", { ...source.input, account: "work", scope: { queries: ["revenue"] }, ...(input as Record<string, unknown>) }),
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
      notes: [
        "bigquery.saved is declared cost.class billed and was checked as metered, with the same price table: the kit's billed-cost check (v0.2.0) is neither run nor not-applicable for a billed snapshot, which answers no page to price. Remove this override when source-contract v0.2.1's billed-cost patch is pinned (review bigquery-9, ruling 3).",
      ],
      sources: reports,
    }
    mkdirSync(join(ROOT, "reports"), { recursive: true })
    writeFileSync(join(ROOT, "reports", "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`)
    expect(report.ok).toBe(true)
  })
})
