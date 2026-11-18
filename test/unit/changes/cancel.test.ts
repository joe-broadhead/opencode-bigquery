// `bigquery_cancel` (design §4, §5.2): a job this account started, at either level, with its own assert before the one
// request. Google's answer is a request, not an outcome, so the result names bigquery_job to see whether the job stopped
// (jobs.cancel, https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel, read 18 Nov 2026).
import { describe, expect, it } from "vitest"
import { SCHEMAS } from "../../../src/domain/contract.js"
import { parse } from "../../../src/tool-spec.js"
import { LOCATION, PROJECT, callsOf, harness, jobStatus, one, readOnly, runTool, signedIn } from "./support.js"

const JOB_ID = "oc_00000000-0000-4000-8000-000000000009"

describe("bigquery_cancel", () => {
  it("cancels a running job on a Read account, with its own assert and no plan", async () => {
    const h = harness(readOnly())
    h.bigquery.on("cancel", async () => jobStatus({ ref: { projectId: PROJECT, jobId: JOB_ID, location: LOCATION }, state: "RUNNING", totalBytesBilled: 0 }))
    const { output, asserted } = await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID, location: LOCATION })
    expect(output).toMatchObject({ state: "cancelled", billed: "unknown", jobState: "RUNNING", job: { project: PROJECT, jobId: JOB_ID, location: LOCATION } })
    expect(String(output.next)).toContain("bigquery_job")
    const commitAssert = one(asserted.filter((request) => request.action === "bigquery.cancel"))
    expect(commitAssert).toMatchObject({ resources: ["default:bigquery.jobs.cancel"], save: ["default:bigquery.jobs.cancel"] })
    expect(commitAssert.metadata).toMatchObject({ account: "default", project: PROJECT, jobId: JOB_ID, location: LOCATION })
    const cancel = callsOf(h.bigquery, "cancel")
    expect(cancel).toHaveLength(1)
    expect(cancel[0]![1]).toEqual({ projectId: PROJECT, jobId: JOB_ID, location: LOCATION })
  })

  it("cancels on a Read and write account too", async () => {
    const h = harness(signedIn())
    h.bigquery.on("cancel", async () => jobStatus({ state: "PENDING", totalBytesBilled: 0 }))
    expect((await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID })).output).toMatchObject({ state: "cancelled", jobState: "PENDING" })
  })

  it("answers done when the job had already finished", async () => {
    const h = harness(readOnly())
    h.bigquery.on("cancel", async () => jobStatus({ ref: { projectId: PROJECT, jobId: JOB_ID, location: LOCATION }, state: "DONE" }))
    const { output } = await runTool(h, "cancel", { project: PROJECT, jobId: JOB_ID, location: LOCATION })
    expect(output).toMatchObject({ state: "done", jobState: "DONE" })
    expect(String(output.message)).toContain("already finished")
  })

  it("treats a job Google already stopped as cancelled, and a real error as failed", async () => {
    const stopped = harness(readOnly())
    stopped.bigquery.on("cancel", async () => jobStatus({ state: "DONE", totalBytesBilled: 0, error: { reason: "stopped" } }))
    const first = await runTool(stopped, "cancel", { project: PROJECT, jobId: JOB_ID })
    expect(first.output).toMatchObject({ state: "cancelled", billed: "unknown" })
    expect(first.output.error).toBeUndefined()

    const denied = harness(readOnly())
    denied.bigquery.on("cancel", async () => jobStatus({ state: "DONE", totalBytesBilled: 0, error: { reason: "notFound", message: "not found" } }))
    const second = await runTool(denied, "cancel", { project: PROJECT, jobId: JOB_ID })
    expect(second.output).toMatchObject({ state: "failed", error: "NOT_FOUND" })
    expect((second.output.googleError as { trust: string }).trust).toBe("untrusted")
  })

  it("refuses a job id the schema does not allow before any request", () => {
    // A tool call is parsed before its handler runs (src/tool-spec.ts buildTool); this is that check.
    expect(() => parse(SCHEMAS.cancel.input, { project: PROJECT, jobId: "has spaces" })).toThrow(/^INPUT_INVALID: /)
  })
})
