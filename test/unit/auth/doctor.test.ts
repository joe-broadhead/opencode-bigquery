// /bigquery-doctor (design §3, L2): the billing project's projects.list, a dry run of SELECT 1, datasets.list, and the
// IAM check for the three write permissions on the first table of each dataset. All calls are free, none reads data,
// and no line carries Google's text.
import { describe, expect, it } from "vitest"
import { runDoctor, WRITE_PERMISSIONS } from "../../../src/auth/doctor.js"
import { BigQueryError } from "../../../src/domain/errors.js"
import { loadOptions } from "../../../src/options.js"
import { FakeAuth, FakeBigQuery, readRecord, writeRecord } from "../../fake/ports.js"

const signal = new AbortController().signal
const CLIENT_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/bigquery"]

function options(extra: Record<string, unknown> = {}) {
  return loadOptions({ accounts: { work: { billingProject: "invented-proj", ...extra } } })
}

function bigquery(input: { readonly table?: string | undefined; readonly datasets?: readonly string[]; readonly permissions?: readonly string[]; readonly projects?: "ok" | "disabled" | "denied" } = {}) {
  const fake = new FakeBigQuery()
  fake.on("listProjects", async () => {
    if (input.projects === "disabled") throw new BigQueryError("API_DISABLED", "The BigQuery API is off in the project")
    if (input.projects === "denied") throw new BigQueryError("PERMISSION_DENIED", "IAM refused bigquery.jobs.create")
    return { items: [{ projectId: "invented-proj" }] }
  })
  fake.on("dryRun", async () => ({ location: "US", statistics: { statementType: "SELECT", totalBytesProcessed: "0" } }))
  fake.on("listDatasets", async () => ({ items: (input.datasets ?? ["ds_one"]).map((datasetId) => ({ ref: { projectId: "invented-proj", datasetId } })) }))
  fake.on("listTables", async (_input: unknown) => ({ items: input.table ? [{ tableReference: { projectId: "invented-proj", datasetId: "ds_one", tableId: input.table } }] : [] }))
  fake.on("testTablePermissions", async (_account: unknown, _ref: unknown, permissions: readonly string[]) => (input.permissions ?? []).filter((permission) => permissions.includes(permission)))
  return fake
}

function scripts(account = readRecord()) {
  return new FakeAuth({ work: { mode: "interactive", record: account, refreshScopes: CLIENT_SCOPES, email: "ada@example.invalid" } })
}

describe("the doctor", () => {
  it("reports IDENTITY_CAN_WRITE with where, and states the check's limit (L2)", async () => {
    const big = bigquery({ table: "t1", permissions: ["bigquery.tables.updateData"] })
    const report = await runDoctor({ options: options(), auth: scripts(), bigquery: big, signal, binding: async () => "bound" })
    expect(report.status).toBe("IDENTITY_CAN_WRITE")
    expect(report.text).toContain("IDENTITY_CAN_WRITE")
    expect(report.text).toContain("`invented-proj`.`ds_one`.`t1`")
    expect(report.text).toContain("bigquery.tables.updateData")
    expect(report.text).toContain("cannot be checked")
    expect(report.text).toContain("Disclosure:")
    expect(report.text).toContain("your admin grant you only BigQuery Job User and Data Viewer")
    const calls = big.calls.map((call) => call.method)
    expect(calls.filter((method) => method === "listProjects")).toHaveLength(1)
    expect(calls.filter((method) => method === "dryRun")).toHaveLength(1)
    expect(calls.filter((method) => method === "testTablePermissions")).toHaveLength(1)
    expect((big.calls.find((call) => call.method === "dryRun")!.args[0] as { sql: string }).sql).toBe("SELECT 1")
    expect([...(big.calls.find((call) => call.method === "testTablePermissions")!.args[2] as readonly string[])].sort()).toEqual([...WRITE_PERMISSIONS].sort())
  })

  it("says OK when no sampled table grants a write permission", async () => {
    const report = await runDoctor({ options: options(), auth: scripts(), bigquery: bigquery({ table: "t1", permissions: [] }), signal })
    expect(report.status).toBe("OK")
    expect(report.text).toContain("No sampled table grants")
  })

  it("checks only the fence's concrete datasets when one is set", async () => {
    const big = bigquery({ table: "t1", permissions: [] })
    await runDoctor({ options: options({ datasets: { allow: ["invented-proj.ds_two", "invented-proj.*"] } }), auth: scripts(), bigquery: big, signal })
    const lists = big.calls.filter((call) => call.method === "listTables")
    expect(lists).toHaveLength(1)
    expect((lists[0]!.args[0] as { dataset: { datasetId: string } }).dataset.datasetId).toBe("ds_two")
  })

  it("maps Google's refusals to the doctor's statuses, without its text", async () => {
    const disabled = await runDoctor({ options: options(), auth: scripts(), bigquery: bigquery({ projects: "disabled" }), signal })
    expect(disabled.status).toBe("API_DISABLED")
    expect(disabled.text).toContain("API_DISABLED")
    const denied = await runDoctor({ options: options(), auth: scripts(), bigquery: bigquery({ projects: "denied" }), signal })
    expect(denied.status).toBe("PERMISSION_DENIED")
  })

  it("warns SCOPE_WIDER_THAN_LEVEL for a gcloud user credential with cloud-platform", async () => {
    const auth = new FakeAuth({ work: { mode: "interactive", record: readRecord(), refreshScopes: ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/cloud-platform"], email: "ada@example.invalid" } })
    const report = await runDoctor({ options: options(), auth, bigquery: bigquery({ table: "t1", permissions: [] }), signal })
    expect(report.text).toContain("SCOPE_WIDER_THAN_LEVEL")
    expect(report.text).toContain("cloud-platform")
  })

  it("reports WRITE_LEVEL_UNVERIFIED when a write record's refresh lacks the marker", async () => {
    const auth = new FakeAuth({ work: { mode: "interactive", record: writeRecord(), refreshScopes: CLIENT_SCOPES, email: "ada@example.invalid" } })
    const report = await runDoctor({ options: options(), auth, bigquery: bigquery({ table: "t1" }), signal })
    expect(report.status).toBe("WRITE_LEVEL_UNVERIFIED")
    expect(report.text).toContain("WRITE_LEVEL_UNVERIFIED")
  })

  it("asks for a billing project before any BigQuery call, and names the account", async () => {
    const big = bigquery()
    const report = await runDoctor({ options: loadOptions({ accounts: { work: {} } }), auth: scripts(), bigquery: big, signal })
    expect(report.status).toBe("BILLING_PROJECT_REQUIRED")
    expect(report.text).toContain("billingProject")
    expect(big.calls).toEqual([])
  })

  it("says no table was available rather than failing the check", async () => {
    const report = await runDoctor({ options: options(), auth: scripts(), bigquery: bigquery({ table: undefined }), signal })
    expect(report.status).toBe("OK")
    expect(report.text).toContain("no table was available")
  })

  it("uses the unbound disclosure wording when the sign-in is not device-bound", async () => {
    const bound = await runDoctor({ options: options(), auth: scripts(), bigquery: bigquery({ table: "t1", permissions: [] }), signal, binding: async () => "bound" })
    const unbound = await runDoctor({ options: options(), auth: scripts(), bigquery: bigquery({ table: "t1", permissions: [] }), signal, binding: async () => "unbound" })
    expect(bound.text).toContain("this plugin's key file")
    expect(unbound.text).not.toContain("this plugin's key file")
    expect(unbound.text).toContain("OpenCode's credential store could")
  })
})
