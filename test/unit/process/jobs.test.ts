// Design §14.1 the read path's runs, with live checks L4 and L5 at the port's boundary: every run carries its byte cap
// on the wire (jobs.insert's configuration.query.maximumBytesBilled); a job Google stopped at the cap or at its time
// limit returns its DONE status with `error` and `totalBytesBilled`, so the read path can name the code and the ledger
// can count what it cost; the same failure arriving as Google's HTTP 400 on getQueryResults is that code already; and a
// repeated client job id is a 409 `duplicate` joined with jobs.get, never a second run.
import { describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { dryRunOf, job, replay } from "../../fake/bigquery.js"
import { fixture, JOB, jobsPath, portFor, runRequest, withFake } from "./support.js"

const signal = () => new AbortController().signal

describe("runs", () => {
  test("the cap is the one the caller passed, and a job stopped at it keeps the code and the 0 it billed (L4)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("job-bytes-billed"))
      replay(fake, fixture("job-bytes-billed-get"))
      const { port } = portFor(fake)
      const jobId = "oc_00000000-0000-4000-8000-000000000002"

      const status = await port.run(runRequest({ jobId, maximumBytesBilled: 1024 }), signal())

      expect(status).toMatchObject({ state: "DONE", totalBytesBilled: 0, error: { reason: "bytesBilledLimitExceeded" } })
      const run = fake.requests.find((request) => request.method === "POST" && dryRunOf(request.body) === false)!
      expect((run.body as { configuration: { query: { maximumBytesBilled?: string } } }).configuration.query.maximumBytesBilled).toBe("1024")
      const again = await port.getJob("default", { projectId: "invented-project", jobId, location: "EU" }, signal())
      expect(again).toMatchObject({ state: "DONE", totalBytesBilled: 0, error: { reason: "bytesBilledLimitExceeded" } })
    })
  })

  test("the same failure as an HTTP 400 on getQueryResults is BYTES_BILLED_LIMIT (L4)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("error-bytes-billed-400"))
      const { port } = portFor(fake)
      const error = (await port.results("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000002", location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error).toBeInstanceOf(BigQueryError)
      expect(error.code).toBe("BYTES_BILLED_LIMIT")
      expect(error.state).toBe("failed")
      expect(error.extras.googleError?.reason).toBe("bytesBilledLimitExceeded")
    })
  })

  test("a job that reached its time limit keeps the bytes it billed, and a 400 says JOB_TIMEOUT (L4)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("job-timeout"))
      const { port } = portFor(fake)
      const status = await port.run(runRequest({ jobId: "oc_00000000-0000-4000-8000-000000000003", jobTimeoutMs: 600_000 }), signal())
      expect(status).toMatchObject({ state: "DONE", totalBytesBilled: 20971520, error: { reason: "timeout" } })
      expect(JSON.stringify(status)).toContain("20971520")
    })

    await withFake(async (fake) => {
      replay(fake, fixture("error-timeout-400"))
      const { port } = portFor(fake)
      const error = (await port.results("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000003", location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("JOB_TIMEOUT")
    })
  })

  test("a job the rate limit stopped is RATE_LIMITED, from its reason on a 400 (M-4)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("error-job-rate-limited-400"))
      const { port } = portFor(fake)
      const error = (await port.results("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000004", location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("RATE_LIMITED")
    })
  })

  test("a repeated client job id is joined with jobs.get and never runs a second time (L5)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("job-running"))
      replay(fake, fixture("error-duplicate"))
      replay(fake, fixture("job-done"))
      const { port } = portFor(fake)
      const request = runRequest()

      const first = await port.run(request, signal())
      expect(first).toMatchObject({ state: "RUNNING", ref: { jobId: JOB, location: "EU" } })

      const joined = await port.run(request, signal())

      expect(joined).toMatchObject({ state: "DONE", ref: { jobId: JOB }, statementType: "SELECT", totalBytesBilled: 10485760 })
      const inserts = fake.requests.filter((entry) => entry.method === "POST" && entry.path === jobsPath)
      expect(inserts).toHaveLength(2)
      for (const insert of inserts) expect((insert.body as { jobReference: { jobId: string } }).jobReference.jobId).toBe(JOB)
      expect(fake.requests.filter((entry) => entry.method === "GET" && entry.path.endsWith(`/jobs/${JOB}`))).toHaveLength(1)
    })
  })

  test("a transport retry after a 503 reuses the same job id", async () => {
    await withFake(async (fake) => {
      fake.enqueue(
        { method: "POST", path: jobsPath, dryRun: false },
        { status: 503, body: { error: { code: 503, message: "Backend error.", errors: [{ reason: "backendError", message: "Backend error." }] } } },
        { status: 200, body: job({ jobReference: { projectId: "invented-project", jobId: JOB, location: "EU" } }) },
      )
      const { port } = portFor(fake)
      const status = await port.run(runRequest(), signal())
      expect(status.ref.jobId).toBe(JOB)
      const inserts = fake.requests.filter((entry) => entry.method === "POST")
      expect(inserts).toHaveLength(2)
      expect(inserts[0]!.body).toEqual(inserts[1]!.body)
    })
  })

  test("refuses a run without a client job id, a cap or a time limit before any request", async () => {
    await withFake(async (fake) => {
      const { port } = portFor(fake)
      for (const request of [runRequest({ jobId: "not-ours" }), runRequest({ maximumBytesBilled: 0 }), runRequest({ jobTimeoutMs: 0 })]) {
        const error = (await port.run(request, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
        expect(error.code).toBe("INPUT_INVALID")
      }
      expect(fake.requests).toHaveLength(0)
    })
  })

  test("sends only labels Google accepts, so a billable job is never refused by one", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("job-running"))
      const { port } = portFor(fake)
      await port.run(runRequest({ labels: { OC_Plugin: "BigQuery", "1bad": "x", oc_session: "Y".repeat(80), "a b": "c" } }), signal())
      const body = fake.requests[0]!.body as { configuration: { labels: Record<string, string> } }
      expect(body.configuration.labels).toEqual({ oc_plugin: "bigquery", oc_session: "y".repeat(63), a_b: "c" })
      for (const [key, value] of Object.entries(body.configuration.labels)) {
        expect(key).toMatch(/^[a-z][a-z0-9_-]{0,62}$/)
        expect(value).toMatch(/^[a-z0-9_-]{0,63}$/)
      }
    })
  })
})
