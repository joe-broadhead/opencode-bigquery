// `bigquery_cancel` (design §4, §5.2, review bigquery-8 H-2): only a job this plugin started — the `oc_` job id and the
// server-side `oc_plugin` label — and, on a Read account, only the plugin's read jobs. A job that is not ours is refused
// before `jobs.cancel`; a read account cannot stop someone else's scheduled query or ETL.
import { describe, expect, it } from "vitest"
import { SCHEMAS } from "../../../src/domain/contract.js"
import { parse } from "../../../src/tool-spec.js"
import { LOCATION, PROJECT, callsOf, harness, jobStatus, one, pluginJob, readOnly, runTool, signedIn } from "./support.js"

const JOB_ID = "oc_00000000-0000-4000-8000-000000000009"
const REF = { projectId: PROJECT, jobId: JOB_ID, location: LOCATION }

describe("bigquery_cancel", () => {
  it("cancels the plugin's own read job on a Read account, after jobs.get, with its own assert", async () => {
    const h = harness(readOnly())
    h.bigquery.on("getJob", async () => pluginJob({ ref: REF, state: "RUNNING", totalBytesBilled: 0 }))
    h.bigquery.on("cancel", async () => pluginJob({ ref: REF, state: "RUNNING", totalBytesBilled: 0 }))
    const { output, asserted } = await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID, location: LOCATION })
    expect(output).toMatchObject({ state: "cancelled", billed: "unknown", jobState: "RUNNING", job: { project: PROJECT, jobId: JOB_ID, location: LOCATION } })
    expect(String(output.next)).toContain("bigquery_job")
    const commitAssert = one(asserted.filter((request) => request.action === "bigquery.cancel"))
    expect(commitAssert).toMatchObject({ resources: ["default:bigquery.jobs.cancel"], save: ["default:bigquery.jobs.cancel"] })
    expect(commitAssert.metadata).toMatchObject({ account: "default", project: PROJECT, jobId: JOB_ID, location: LOCATION })
    // jobs.get comes before jobs.cancel.
    const calls = h.bigquery.calls.map((call) => call.method)
    expect(calls.indexOf("getJob")).toBeLessThan(calls.indexOf("cancel"))
    const cancel = callsOf(h.bigquery, "cancel")
    expect(cancel).toHaveLength(1)
    expect(cancel[0]![1]).toEqual({ projectId: PROJECT, jobId: JOB_ID, location: LOCATION })
  })

  it("cancels the plugin's own write job on a Read and write account", async () => {
    const h = harness(signedIn())
    h.bigquery.on("getJob", async () => pluginJob({ ref: REF, state: "RUNNING", totalBytesBilled: 0, labels: { oc_plugin: "bigquery-plugin", oc_tool: "bigquery_write" } }))
    h.bigquery.on("cancel", async () => pluginJob({ ref: REF, state: "RUNNING", totalBytesBilled: 0 }))
    expect((await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID, location: LOCATION })).output).toMatchObject({ state: "cancelled" })
  })

  it("refuses a job this plugin did not start, before any cancel", async () => {
    for (const [what, status] of [
      ["no label", jobStatus({ ref: REF, state: "RUNNING", totalBytesBilled: 0 })],
      ["another tool's label", jobStatus({ ref: REF, state: "RUNNING", totalBytesBilled: 0, labels: { oc_plugin: "someone-else" } })],
      ["a non-oc id", pluginJob({ ref: { ...REF, jobId: "job_invented_1" }, state: "RUNNING", totalBytesBilled: 0 })],
    ] as const) {
      const h = harness(readOnly())
      h.bigquery.on("getJob", async () => status)
      const { output } = await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID, location: LOCATION })
      expect(output, what).toMatchObject({ state: "refused", error: "PERMISSION_DENIED" })
      expect(String(output.message), what).toContain("was not started by this plugin")
      expect(callsOf(h.bigquery, "cancel"), what).toEqual([])
    }
  })

  it("refuses a plugin write job on a Read account, before any cancel", async () => {
    const h = harness(readOnly())
    h.bigquery.on("getJob", async () => pluginJob({ ref: REF, state: "RUNNING", totalBytesBilled: 0, labels: { oc_plugin: "bigquery-plugin", oc_tool: "bigquery_delete" } }))
    const { output } = await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID, location: LOCATION })
    expect(output).toMatchObject({ state: "refused", error: "PERMISSION_DENIED" })
    expect(String(output.message)).toContain("cancels only this plugin's read jobs")
    expect(callsOf(h.bigquery, "cancel")).toEqual([])
  })

  it("answers done for a finished plugin job without calling jobs.cancel", async () => {
    const h = harness(readOnly())
    h.bigquery.on("getJob", async () => pluginJob({ ref: REF, state: "DONE" }))
    const { output } = await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID, location: LOCATION })
    expect(output).toMatchObject({ state: "done", jobState: "DONE" })
    expect(String(output.message)).toContain("already finished")
    expect(callsOf(h.bigquery, "cancel")).toEqual([])
  })

  it("treats a plugin job Google already stopped as cancelled, and a real error as failed", async () => {
    const stopped = harness(readOnly())
    stopped.bigquery.on("getJob", async () => pluginJob({ ref: REF, state: "DONE", totalBytesBilled: 0, error: { reason: "stopped" } }))
    const first = await runTool(stopped, "cancel", { project: PROJECT, jobId: JOB_ID })
    expect(first.output).toMatchObject({ state: "cancelled", billed: "unknown" })
    expect(first.output.error).toBeUndefined()
    expect(callsOf(stopped.bigquery, "cancel")).toEqual([])

    const denied = harness(readOnly())
    denied.bigquery.on("getJob", async () => pluginJob({ ref: REF, state: "DONE", totalBytesBilled: 0, error: { reason: "notFound", message: "not found" } }))
    const second = await runTool(denied, "cancel", { project: PROJECT, jobId: JOB_ID })
    expect(second.output).toMatchObject({ state: "failed", error: "NOT_FOUND" })
    expect((second.output.googleError as { trust: string }).trust).toBe("untrusted")
  })

  it("refuses a job id the schema does not allow before any request", () => {
    // A tool call is parsed before its handler runs (src/tool-spec.ts buildTool); this is that check.
    expect(() => parse(SCHEMAS.cancel.input, { project: PROJECT, jobId: "has spaces" })).toThrow(/^INPUT_INVALID: /)
  })
})
