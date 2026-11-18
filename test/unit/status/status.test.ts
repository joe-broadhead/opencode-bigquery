// Package F's unit suite for `bigquery_status` (design §13): the accounts and levels, the caps, the ledger's spend, and
// the free checks `include` adds. Nothing here reaches Google: the Day 0 fakes answer every port.
import { describe, expect, it } from "vitest"
import { authState } from "../../../src/auth/state.js"
import { StatusOutput } from "../../../src/domain/contract.js"
import { BigQueryError } from "../../../src/domain/errors.js"
import { DISCLOSURE } from "../../../src/domain/levels.js"
import { sessionHash } from "../../../src/guards/session.js"
import { readRecord, writeRecord, type FakeAuth } from "../../fake/ports.js"
import { ACCOUNT, LOCATION, PROJECT, callsOf, harness, runTool, twoAccounts } from "./support.js"

/** The contract's own shape: every result is checked against the schema the model and scripts see. */
const shape = (output: Record<string, unknown>) => StatusOutput.parse(JSON.parse(JSON.stringify(output))) as Record<string, unknown>

describe("bigquery_status", () => {
  it("names the account, its level, the caps and the ledger's spend, and calls no BigQuery method", async () => {
    const h = harness()
    const { output, asserted } = await runTool(h, "status", {})
    expect(shape(output)).toMatchObject({
      state: "done",
      accounts: [{ alias: ACCOUNT, mode: "interactive", level: "read", billingProject: PROJECT, location: LOCATION }],
      caps: { maxBytesBilled: 10 * 2 ** 30, maxBytesCeiling: 100 * 2 ** 30 },
      spend: { todayBytes: 0, sessionBytes: 0, todayUsd: 0 },
    })
    // The status is a local assert: no account, no operation, no Google request.
    expect(asserted).toHaveLength(1)
    expect(asserted[0]).toMatchObject({ action: "bigquery.status", resources: ["*"] })
    expect(h.bigquery.calls).toEqual([])
  })

  it("shows a Read account's disclosure in the form's pre-binding wording until the binding accessor answers", async () => {
    const h = harness()
    const plain = await runTool(h, "status", {})
    const account = (shape(plain.output).accounts as { binding?: string; disclosure?: string }[])[0]!
    expect(account.binding).toBeUndefined()
    expect(account.disclosure).toBe(`${DISCLOSURE.bound} ${DISCLOSURE.formSuffix}`)

    // The accessor A adds (contract request 3) switches the wording, and names the binding itself.
    ;(h.auth as FakeAuth & { binding?: (account: string, signal: AbortSignal) => Promise<"bound" | "unbound" | undefined> }).binding = async () => "unbound"
    const { output } = await runTool(h, "status", {})
    const bound = (shape(output).accounts as { binding?: string; disclosure?: string }[])[0]!
    expect(bound.binding).toBe("unbound")
    expect(bound.disclosure).toBe(DISCLOSURE.unbound)
  })

  it("says why a Read and write sign-in is read when a §3.1 check fails", async () => {
    // The record says write, but Google's refresh does not return the marker: WRITE_LEVEL_UNVERIFIED, not a bare read.
    const h = harness({ mode: "interactive", record: writeRecord(), refreshScopes: ["https://www.googleapis.com/auth/bigquery"] })
    const { output } = await runTool(h, "status", {})
    expect((shape(output).accounts as { level: string }[])[0]!.level).toBe("read")
    expect(String(output.next)).toContain("WRITE_LEVEL_UNVERIFIED")
    expect(String(output.next)).toContain("write marker")
  })

  it("decides the level from both §3.1 checks: a write record and the marker make write", async () => {
    const h = harness({ mode: "interactive", record: writeRecord(), refreshScopes: ["https://www.googleapis.com/auth/bigquery", "https://www.googleapis.com/auth/bigquery.insertdata"] })
    const { output } = await runTool(h, "status", {})
    expect((shape(output).accounts as { level: string }[])[0]!.level).toBe("write")
  })

  it("answers read, with the sign-in's next step, when the account cannot get a token", async () => {
    // No record at all: the interactive account is not signed in, and the real level() refuses before any request.
    const h = harness({ mode: "interactive", refreshScopes: [] })
    h.auth.level = async () => {
      throw new BigQueryError("AUTH_REQUIRED", `The account ${ACCOUNT} is not signed in, and Google was not called`, "Run /connect and choose BigQuery to sign in again.")
    }
    const { output } = await runTool(h, "status", {})
    expect(shape(output)).toMatchObject({ state: "done", accounts: [{ level: "read" }] })
    expect(String(output.next)).toContain("/connect")
    expect(h.bigquery.calls).toEqual([])
  })

  it("lists every configured account when the call names none, and sums what the ledger says", async () => {
    const h = twoAccounts()
    const session = sessionHash("ses_status_1")
    await h.ledger.record({ at: "2026-11-17T09:00:00.000Z", account: ACCOUNT, project: PROJECT, location: LOCATION, jobId: "oc_a", bytesBilled: 2 ** 30, via: "bigquery_query", session })
    await h.ledger.record({ at: "2026-11-17T09:05:00.000Z", account: "work", project: "invented-work", location: "EU", jobId: "oc_b", bytesBilled: 2 ** 30, via: "bigquery_query", session })
    const { output } = await runTool(h, "status", {})
    expect((shape(output).accounts as { alias: string }[]).map((account) => account.alias)).toEqual([ACCOUNT, "work"])
    expect(shape(output).spend).toMatchObject({ todayBytes: 2 ** 31, sessionBytes: 2 ** 31 })
    expect(h.bigquery.calls).toEqual([])
  })

  it("counts this session's bytes by its hash, never the other session's", async () => {
    const h = harness()
    const session = sessionHash("ses_status_1")
    await h.ledger.record({ at: "2026-11-17T09:00:00.000Z", account: ACCOUNT, project: PROJECT, location: LOCATION, jobId: "oc_a", bytesBilled: 1024, via: "bigquery_query", session })
    await h.ledger.record({ at: "2026-11-17T09:01:00.000Z", account: ACCOUNT, project: PROJECT, location: LOCATION, jobId: "oc_b", bytesBilled: 2048, via: "bigquery_query", session: "ffffffffffffffff" })
    const { output } = await runTool(h, "status", {})
    expect(shape(output).spend).toMatchObject({ todayBytes: 3072, sessionBytes: 1024 })
  })

  it("warns that a headless account's queries run as its own principal", async () => {
    const h = harness({ mode: "adc", refreshScopes: ["https://www.googleapis.com/auth/bigquery"] })
    const { output } = await runTool(h, "status", {})
    expect(shape(output).accounts).toMatchObject([{ mode: "adc", level: "read" }])
    expect(shape(output).warnings).toMatchObject([{ code: "HEADLESS_IDENTITY" }])
  })

  it("lists running jobs only when include asks, with a free jobs.list", async () => {
    const h = harness()
    h.bigquery.on("listJobs", async () => ({ items: [{ ref: { projectId: PROJECT, jobId: "oc_running", location: LOCATION }, state: "RUNNING" }] }))
    const quiet = await runTool(h, "status", {})
    expect(quiet.output.message).toBeUndefined()
    expect(callsOf(h.bigquery, "listJobs")).toEqual([])

    const asked = await runTool(h, "status", { include: ["jobs"] })
    expect(callsOf(h.bigquery, "listJobs")).toEqual([[{ account: ACCOUNT, project: PROJECT, stateFilter: "running", maxResults: 100 }, expect.any(AbortSignal)]])
    expect(asked.output.message).toBe("1 job is running: default:`oc_running` (`US`).")
  })

  it("runs the IAM check on demand and warns when the identity can change data", async () => {
    const h = harness()
    h.bigquery.on("listDatasets", async () => ({ items: [{ ref: { projectId: PROJECT, datasetId: "sales" } }] }))
    h.bigquery.on("listTables", async () => ({ items: [{ tableReference: { projectId: PROJECT, datasetId: "sales", tableId: "orders" } }] }))
    h.bigquery.on("testTablePermissions", async () => ["bigquery.tables.updateData"])
    const { output } = await runTool(h, "status", { include: ["iam"] })
    expect((shape(output).warnings as { code: string; message: string }[])[0]!.code).toBe("IDENTITY_CAN_WRITE")
    expect((shape(output).warnings as { message: string }[])[0]!.message).toContain("`invented-proj`.`sales`.`orders`")
    expect((shape(output).warnings as { message: string }[])[0]!.message).toContain("bigquery.tables.updateData")

    const clean = harness()
    clean.bigquery.on("listDatasets", async () => ({ items: [{ ref: { projectId: PROJECT, datasetId: "sales" } }] }))
    clean.bigquery.on("listTables", async () => ({ items: [{ tableReference: { projectId: PROJECT, datasetId: "sales", tableId: "orders" } }] }))
    clean.bigquery.on("testTablePermissions", async () => [])
    const { output: ok } = await runTool(clean, "status", { include: ["iam"] })
    expect(shape(ok).warnings).toBeUndefined()
  })

  it("warns when a headless credential carries cloud-platform, and only when include asks", async () => {
    const scopes = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/bigquery"]
    const quiet = harness({ mode: "adc", refreshScopes: ["https://www.googleapis.com/auth/bigquery"] })
    const { output: quietOut } = await runTool(quiet, "status", {})
    expect((shape(quietOut).warnings as { code: string }[]).map((warning) => warning.code)).toEqual(["HEADLESS_IDENTITY"])

    const h = harness({ mode: "adc", refreshScopes: scopes })
    h.bigquery.on("listDatasets", async () => ({ items: [] }))
    const { output } = await runTool(h, "status", { include: ["iam"] })
    expect((shape(output).warnings as { code: string }[]).map((warning) => warning.code)).toContain("SCOPE_WIDER_THAN_LEVEL")
  })

  it("runs the IAM check once at the first status after a Read sign-in, consuming the pending marker", async () => {
    const h = harness()
    authState(h.options).iamPending.add(`${ACCOUNT}|key-invented-1`)
    h.bigquery.on("listDatasets", async () => ({ items: [{ ref: { projectId: PROJECT, datasetId: "sales" } }] }))
    h.bigquery.on("listTables", async () => ({ items: [{ tableReference: { projectId: PROJECT, datasetId: "sales", tableId: "orders" } }] }))
    h.bigquery.on("testTablePermissions", async () => ["bigquery.tables.updateData"])
    const first = await runTool(h, "status", {})
    const second = await runTool(h, "status", {})
    expect(callsOf(h.bigquery, "testTablePermissions")).toHaveLength(1)
    expect(shape(first.output).warnings).toMatchObject([{ code: "IDENTITY_CAN_WRITE" }])
    expect(shape(second.output).warnings).toBeUndefined()
    expect(authState(h.options).iamPending.size).toBe(0)
  })

  it("keeps a pending IAM marker when the account has no billingProject", async () => {
    const h = harness({ mode: "interactive", record: readRecord(), refreshScopes: [] }, { accounts: { default: { mode: "interactive" } } })
    authState(h.options).iamPending.add(`${ACCOUNT}|key-invented-1`)
    await runTool(h, "status", {})
    expect(authState(h.options).iamPending.has(`${ACCOUNT}|key-invented-1`)).toBe(true)
    expect(callsOf(h.bigquery, "testTablePermissions")).toEqual([])
  })

  it("accepts include: spend, which is the ledger the status always reads, and never queries Google", async () => {
    const h = harness()
    const { output } = await runTool(h, "status", { include: ["spend"] })
    expect(shape(output).spend).toMatchObject({ todayBytes: 0 })
    expect(h.bigquery.calls).toEqual([])
  })
})
