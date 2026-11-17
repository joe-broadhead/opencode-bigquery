// The review's probes for round 2 (plan/reviews/wave-B/bigquery-2-probes.test.ts), adapted where the ruling chose a
// resolution, so each finding stays a test. Each body is shaped from the page cited above it, not from a fixture.
import { describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import type { SchemaField } from "../../../src/domain/google.js"
import { createHttp } from "../../../src/process/http.js"
import { convertValue } from "../../../src/process/values.js"
import { job } from "../../fake/bigquery.js"
import type { FakeAnswer, RecordedRequest } from "../../fake/server.js"
import { cancelPath, inFlight, jobsPath, JOB, portFor, resultsPath, routedFetch, runRequest, testAuth, withFake } from "./support.js"

const signal = () => new AbortController().signal
const TABLE = { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }
const tablePath = "/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_table"
const cancelAnswer = (state = "RUNNING"): FakeAnswer => ({ status: 200, body: { kind: "bigquery#jobCancelResponse", job: job({ jobReference: { projectId: "invented-project", jobId: JOB, location: "EU" }, status: { state } }) } })
const notFound: FakeAnswer = { status: 404, body: { error: { code: 404, message: "Not found: Job", errors: [{ reason: "notFound", message: "Not found: Job" }] } } }

describe("review probes, round 2", () => {
  // H-1. RowAccessPolicy: the id is in `rowAccessPolicyReference` (…/rowAccessPolicies).
  test("P1 rowAccessPolicies.list keeps a documented entry", async () => {
    await withFake(async (fake) => {
      fake.answer(
        { method: "GET", path: `${tablePath}/rowAccessPolicies` },
        {
          status: 200,
          body: {
            rowAccessPolicies: [
              {
                etag: "x",
                rowAccessPolicyReference: { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table", policyId: "invented_policy" },
                filterPredicate: "region = 'EU'",
                creationTime: "1763377200000",
                lastModifiedTime: "1763377200000",
              },
            ],
          },
        },
      )
      const { port } = portFor(fake)
      const page = await port.listRowAccessPolicies("default", TABLE, signal())
      expect(page.items).toEqual([{ policyId: "invented_policy" }])
    })
  })

  test("P1b an entry the code cannot read still counts as a policy (fail closed)", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: `${tablePath}/rowAccessPolicies` }, { status: 200, body: { rowAccessPolicies: [{ etag: "x", filterPredicate: "TRUE" }] } })
      const { port } = portFor(fake)
      await expect(port.listRowAccessPolicies("default", TABLE, signal())).resolves.toEqual({ items: [{ policyId: "" }] })
    })
  })

  test("P1c an empty first page with a page token is read on, not reported as no policy", async () => {
    await withFake(async (fake) => {
      fake.enqueue(
        { method: "GET", path: `${tablePath}/rowAccessPolicies` },
        { status: 200, body: { rowAccessPolicies: [], nextPageToken: "page-2" } },
        { status: 200, body: { rowAccessPolicies: [{ rowAccessPolicyReference: { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table", policyId: "later" } }] } },
      )
      const { port } = portFor(fake)
      await expect(port.listRowAccessPolicies("default", TABLE, signal())).resolves.toEqual({ items: [{ policyId: "later" }] })
      expect(fake.requests[1]!.query.pageToken).toBe("page-2")
    })
  })

  // M-1. POST …/v2/{resource=projects/*/datasets/*/tables/*}:testIamPermissions (…/tables/testIamPermissions).
  test("P2 tables.testIamPermissions posts to the colon path", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: `${tablePath}:testIamPermissions` }, { status: 200, body: { permissions: ["bigquery.tables.getData"] } })
      const { port } = portFor(fake)
      await port.testTablePermissions("default", TABLE, ["bigquery.tables.getData"], signal())
      expect(fake.requests[0]!.path).toBe(`${tablePath}:testIamPermissions`)
    })
  })

  // M-2. jobs.cancel answers { kind, job } (…/jobs/cancel), and its body must be empty.
  test("P3 jobs.cancel reads the Job under `job`", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: cancelPath() }, cancelAnswer("RUNNING"))
      const { port } = portFor(fake)
      const status = await port.cancel("default", { projectId: "invented-project", jobId: JOB, location: "EU" }, signal())
      expect(status.state).toBe("RUNNING")
      expect(fake.requests[0]!.body).toBeUndefined()
    })
  })

  // M-3. rateLimitExceeded is 403 or 429 and is retried (error messages; design §8).
  test("P4 a 403 rateLimitExceeded is RATE_LIMITED and retried", async () => {
    await withFake(async (fake) => {
      fake.answer(
        { method: "GET", path: resultsPath() },
        { status: 403, headers: { "retry-after": "1" }, body: { error: { code: 403, message: "Exceeded rate limits", errors: [{ reason: "rateLimitExceeded", domain: "usageLimits", message: "x" }] } } },
      )
      const { port } = portFor(fake)
      const error = (await port.results("default", { projectId: "invented-project", jobId: JOB, location: "EU" }, { timeoutMs: 1000, maxResults: 51 }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("RATE_LIMITED")
      expect(error.extras.retryAfterSec).toBe(1)
      expect(fake.requests).toHaveLength(3)
    })
  })

  // M-4. A job failure arrives as an HTTP 400 on getQueryResults (error messages: bytesBilledLimitExceeded, timeout).
  test("P5 a job failure that arrives as HTTP 400 gets the job code", async () => {
    await withFake(async (fake) => {
      fake.answer(
        { method: "GET", path: resultsPath() },
        { status: 400, body: { error: { code: 400, message: "Query exceeded limit for bytes billed: 1024.", errors: [{ reason: "bytesBilledLimitExceeded", domain: "global", message: "x" }] } } },
      )
      const { port } = portFor(fake)
      const error = (await port.results("default", { projectId: "invented-project", jobId: JOB, location: "EU" }, { timeoutMs: 1000, maxResults: 51 }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("BYTES_BILLED_LIMIT")
    })
  })

  // L-1. "In some cases, a 5xx response code might be returned by an intermediate server such as a proxy" (error messages).
  test("P6 a 503 with an HTML body is retried", async () => {
    await withFake(async (fake) => {
      fake.enqueue(
        { method: "GET", path: tablePath },
        { status: 503, headers: { "content-type": "text/html" }, body: "<html>Service Unavailable</html>" },
        { status: 200, body: { tableReference: TABLE, type: "TABLE" } },
      )
      const { port } = portFor(fake)
      const answer = await port.getTable("default", TABLE, signal())
      expect(answer.type).toBe("TABLE")
      expect(fake.requests).toHaveLength(2)
    })
  })

  // M-5. TIMESTAMP: useInt64Timestamp gives exact microseconds; the default form is parsed without a double.
  test("P7 TIMESTAMP at both ends of the range, in both forms", () => {
    const field: SchemaField = { name: "ts", type: "TIMESTAMP" }
    expect(convertValue(field, "1.700000000123456E9")).toBe("2023-11-14T22:13:20.123456Z")
    expect(convertValue(field, "-6.21355968E10")).toBe("0001-01-01T00:00:00.000Z")
    expect(convertValue(field, "2.53402300799999999E11")).toBe("9999-12-31T23:59:59.999999Z")
    expect(convertValue(field, "253402300799999999")).toBe("9999-12-31T23:59:59.999999Z")
    expect(convertValue(field, "-62135596800000000")).toBe("0001-01-01T00:00:00.000Z")
  })

  // L-8 (a). The run's answer names the location Google used; a stop must cancel with it.
  test("P8 a stop after an inferred location cancels with the location Google reported", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 200, body: job({ jobReference: { projectId: "invented-project", jobId: JOB, location: "europe-west3" }, status: { state: "RUNNING" } }) })
      fake.answer({ method: "GET", path: resultsPath() }, { status: 200, body: new Promise(() => undefined) })
      fake.answer({ method: "POST", path: cancelPath() }, cancelAnswer())
      const { port } = portFor(fake)
      const status = await port.run(runRequest({ location: "" }), signal())
      expect(status.ref.location).toBe("europe-west3")
      const controller = new AbortController()
      const call = port.results("default", status.ref, { timeoutMs: 30_000, maxResults: 51 }, controller.signal)
      await inFlight(fake, (request) => request.method === "GET" && request.path === resultsPath())
      controller.abort()
      await call.catch(() => undefined)
      const cancel = fake.requests.find((request) => request.method === "POST" && request.path === cancelPath())!
      expect(cancel.query.location).toBe("europe-west3")
    })
  })

  // L-8 (b). A stop during jobs.insert knows no location: the port asks jobs.get for it, then cancels with it.
  test("P8b a stop during run() locates the job, then cancels with its location", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 200, body: new Promise(() => undefined) })
      fake.answer({ method: "GET", path: `${jobsPath}/${JOB}` }, { status: 200, body: job({ jobReference: { projectId: "invented-project", jobId: JOB, location: "europe-west3" }, status: { state: "RUNNING" } }) })
      fake.answer(
        { method: "POST", path: cancelPath() },
        (request: RecordedRequest) => (request.query.location === undefined ? notFound : cancelAnswer()),
      )
      const { port } = portFor(fake)
      const controller = new AbortController()
      const call = port.run(runRequest({ location: "" }), controller.signal)
      await inFlight(fake, (request) => request.method === "POST" && request.path === jobsPath)
      controller.abort()
      await call.catch(() => undefined)
      const cancels = fake.requests.filter((request) => request.method === "POST" && request.path === cancelPath())
      expect(cancels.length).toBe(2)
      expect(cancels[1]!.query.location).toBe("europe-west3")
      expect(fake.requests.some((request) => request.method === "GET" && request.path === `${jobsPath}/${JOB}`)).toBe(true)
    })
  })

  // M-4. getQueryResults' errors[] "do not necessarily mean the job … was unsuccessful" (…/jobs/getQueryResults).
  test("P9 a finished job with a warning in errors[] still returns its rows", async () => {
    await withFake(async (fake) => {
      fake.answer(
        { method: "GET", path: resultsPath() },
        { status: 200, body: { jobComplete: true, totalRows: "1", schema: { fields: [{ name: "x", type: "INT64" }] }, rows: [{ f: [{ v: "1" }] }], errors: [{ reason: "invalid", message: "a warning", location: "query" }] } },
      )
      const { port } = portFor(fake)
      const page = await port.results("default", { projectId: "invented-project", jobId: JOB, location: "EU" }, { timeoutMs: 1000, maxResults: 51 }, signal())
      expect(page.rows).toHaveLength(1)
    })
  })

  // M-4. A failed job is a result: its DONE status carries the bytes it billed (the ruling's first option).
  test("P10 a timed-out job's billed bytes reach the caller", async () => {
    await withFake(async (fake) => {
      fake.answer(
        { method: "POST", path: jobsPath, dryRun: false },
        { status: 200, body: job({ statistics: { query: { statementType: "SELECT", totalBytesBilled: "20971520" } }, status: { state: "DONE", errorResult: { reason: "timeout", message: "x" } } }) },
      )
      const { port } = portFor(fake)
      const status = await port.run(runRequest(), signal())
      expect(status.error?.reason).toBe("timeout")
      expect(status.totalBytesBilled).toBe(20971520)
    })
  })

  // L-2. A stop ends the backoff sleep at once.
  test("P11 a stop during a retry backoff returns promptly", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: tablePath }, { status: 503, body: { error: { code: 503, message: "x", errors: [{ reason: "backendError" }] } } })
      const http = createHttp({ auth: testAuth(), fetch: routedFetch(fake.origin), retry: { tries: 3, baseDelayMs: 1500, maxDelayMs: 8000, jitter: false } })
      const controller = new AbortController()
      const started = Date.now()
      const call = http.request({ account: "default", method: "GET", path: tablePath, task: "t", signal: controller.signal, idempotent: true }).catch((error: unknown) => error)
      await inFlight(fake, () => true)
      controller.abort()
      await call
      expect(Date.now() - started).toBeLessThan(600)
    })
  })

  // L-5. `..` is not escaped by encodeURIComponent and WHATWG URL resolves it.
  test("P12 a dot segment is refused", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: /.*/ }, { status: 200, body: {} })
      const { port } = portFor(fake)
      const error = (await port.getJob("default", { projectId: "invented-project", jobId: "..", location: "EU" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("INPUT_INVALID")
      expect(fake.requests).toHaveLength(0)
    })
  })

  // L-8. location "" must not reach the wire (…/troubleshoot-queries: "Job not found … no value for location").
  test("P13 an empty location is not sent", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: resultsPath() }, { status: 200, body: { jobComplete: true } })
      const { port } = portFor(fake)
      await port.results("default", { projectId: "invented-project", jobId: JOB, location: "" }, { timeoutMs: 1, maxResults: 1 }, signal())
      expect(fake.requests[0]!.query).not.toHaveProperty("location")
    })
  })

  // L-8. A 409 may arrive before the job is visible: one short jobs.get retry (…/troubleshoot-queries).
  test("P14 the 409 join survives a job that is not visible yet", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 409, body: { error: { code: 409, message: "Already Exists", errors: [{ reason: "duplicate" }] } } })
      fake.enqueue(
        { method: "GET", path: `${jobsPath}/${JOB}` },
        notFound,
        { status: 200, body: job({ jobReference: { projectId: "invented-project", jobId: JOB, location: "EU" }, status: { state: "RUNNING" } }) },
      )
      const { port } = portFor(fake)
      const answer = await port.run(runRequest({ location: "" }), signal())
      expect(answer.state).toBe("RUNNING")
      expect(fake.requests.filter((request) => request.method === "GET" && request.path === `${jobsPath}/${JOB}`)).toHaveLength(2)
    })
  })
})
