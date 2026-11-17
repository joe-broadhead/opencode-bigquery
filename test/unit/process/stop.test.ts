// Design §14.3, Stop: the call's signal aborts its request, and the port cancels the job that call started, with
// jobs.cancel (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel). A stop only ever cancels the
// caller's own job; the answer is CANCELLED, and what it billed is unknown.
//
// Each test waits until the fake has the request, then stops it while the fake still holds the answer open (a body
// that never settles): no assertion depends on a timer winning a race against a busy machine.
import { describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { pending } from "../../fake/bigquery.js"
import { cancelPath, inFlight, jobsPath, JOB, portFor, resultsPath, runRequest, withFake } from "./support.js"

const job = (jobId = JOB, state = "RUNNING") => ({ jobReference: { projectId: "invented-project", jobId, location: "EU" }, status: { state } })
/** jobs.cancel answers `{ kind, job }` (…/jobs/cancel). */
const cancelAnswer = (state = "DONE") => ({ status: 200, body: { kind: "bigquery#jobCancelResponse", job: job(JOB, state) } })
const cancelRequests = (requests: readonly { method: string; path: string; query: Readonly<Record<string, string>> }[]) => requests.filter((request) => request.method === "POST" && request.path.endsWith("/cancel"))

describe("stop", () => {
  test("aborts a run that is in flight and cancels the job it started", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 200, body: pending() })
      fake.answer({ method: "POST", path: cancelPath() }, cancelAnswer())
      const { port } = portFor(fake)
      const controller = new AbortController()

      const call = port.run(runRequest(), controller.signal)
      await inFlight(fake, (request) => request.method === "POST" && request.path === jobsPath)
      controller.abort()
      const error = await call.catch((thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(BigQueryError)
      expect((error as BigQueryError).code).toBe("CANCELLED")
      expect((error as BigQueryError).state).toBe("cancelled")
      const cancels = cancelRequests(fake.requests)
      expect(cancels).toHaveLength(1)
      expect(cancels[0]!.path).toBe(cancelPath())
      expect(cancels[0]!.query.location).toBe("EU")
      // The cancel answered, so the port did not have to look the job up first.
      expect(fake.requests.filter((request) => request.method === "GET" && request.path === `${jobsPath}/${JOB}`)).toHaveLength(0)
    })
  }, 10_000)

  test("aborts a result long-poll and cancels the job the same call started", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 200, body: job() })
      fake.answer({ method: "GET", path: resultsPath() }, { status: 200, body: pending() })
      fake.answer({ method: "POST", path: cancelPath() }, cancelAnswer())
      const { port } = portFor(fake)
      await port.run(runRequest(), new AbortController().signal)
      const controller = new AbortController()

      const call = port.results("default", { projectId: "invented-project", jobId: JOB, location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, controller.signal)
      await inFlight(fake, (request) => request.method === "GET" && request.path === resultsPath())
      controller.abort()
      const error = await call.catch((thrown: unknown) => thrown)

      expect((error as BigQueryError).code).toBe("CANCELLED")
      expect(cancelRequests(fake.requests)).toHaveLength(1)
    })
  }, 10_000)

  test("never cancels a job this port did not start", async () => {
    await withFake(async (fake) => {
      const foreign = "oc_00000000-0000-4000-8000-0000000000aa"
      fake.answer({ method: "GET", path: resultsPath(foreign) }, { status: 200, body: pending() })
      const { port } = portFor(fake)
      const controller = new AbortController()

      const call = port.results("default", { projectId: "invented-project", jobId: foreign, location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, controller.signal)
      await inFlight(fake, (request) => request.method === "GET" && request.path === resultsPath(foreign))
      controller.abort()
      const error = await call.catch((thrown: unknown) => thrown)

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
  })
})
