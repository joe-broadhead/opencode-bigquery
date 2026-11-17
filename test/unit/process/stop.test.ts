// Design §14.3, Stop: the call's signal aborts its request, and the port cancels the job that call started, with
// jobs.cancel (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel). A stop only ever cancels the
// caller's own job; the answer is CANCELLED, and what it billed is unknown.
import { describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { cancelPath, jobsPath, JOB, portFor, resultsPath, runRequest, withFake } from "./support.js"

const job = (jobId = JOB, state = "RUNNING") => ({ jobReference: { projectId: "invented-project", jobId, location: "EU" }, status: { state } })

/** Aborts a controller after `ms`, so the request is in flight when it happens. */
function abortSoon(controller: AbortController, ms = 30): void {
  setTimeout(() => controller.abort(), ms)
}

const cancelRequests = (requests: readonly { method: string; path: string }[]) => requests.filter((request) => request.method === "POST" && request.path.endsWith("/cancel"))

describe("stop", () => {
  test("aborts a run that is in flight and cancels the job it started", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 200, delayMs: 300, body: job() })
      fake.answer({ method: "POST", path: cancelPath() }, { status: 200, body: job(JOB, "DONE") })
      const { port } = portFor(fake)
      const controller = new AbortController()
      abortSoon(controller)

      const error = await port.run(runRequest(), controller.signal).catch((thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(BigQueryError)
      expect((error as BigQueryError).code).toBe("CANCELLED")
      expect((error as BigQueryError).state).toBe("cancelled")
      const cancels = cancelRequests(fake.requests)
      expect(cancels).toHaveLength(1)
      expect(cancels[0]!.path).toBe(cancelPath())
    })
  }, 10_000)

  test("aborts a result long-poll and cancels the job the same call started", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 200, body: job() })
      fake.answer({ method: "GET", path: resultsPath() }, { status: 200, delayMs: 300, body: { jobComplete: false } })
      fake.answer({ method: "POST", path: cancelPath() }, { status: 200, body: job(JOB, "DONE") })
      const { port } = portFor(fake)
      await port.run(runRequest(), new AbortController().signal)
      const controller = new AbortController()
      abortSoon(controller)

      const error = await port.results("default", { projectId: "invented-project", jobId: JOB, location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, controller.signal).catch((thrown: unknown) => thrown)

      expect((error as BigQueryError).code).toBe("CANCELLED")
      expect(cancelRequests(fake.requests)).toHaveLength(1)
    })
  }, 10_000)

  test("never cancels a job this port did not start", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: resultsPath("oc_00000000-0000-4000-8000-0000000000aa") }, { status: 200, delayMs: 300, body: { jobComplete: false } })
      const { port } = portFor(fake)
      const controller = new AbortController()
      abortSoon(controller)

      const error = await port.results("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-0000000000aa", location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, controller.signal).catch((thrown: unknown) => thrown)

      expect((error as BigQueryError).code).toBe("CANCELLED")
      expect(cancelRequests(fake.requests)).toHaveLength(0)
    })
  }, 10_000)

  test("a stopped signal sends nothing at all", async () => {
    await withFake(async (fake) => {
      const { port, auth } = portFor(fake)
      const controller = new AbortController()
      controller.abort()

      const error = await port.run(runRequest(), controller.signal).catch((thrown: unknown) => thrown)

      expect((error as BigQueryError).code).toBe("CANCELLED")
      expect(fake.requests).toHaveLength(0)
      // Not even a token was asked for.
      expect(auth.calls.filter((call) => call.method === "token")).toHaveLength(0)
    })
  }, 10_000)
})
