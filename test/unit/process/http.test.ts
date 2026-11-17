// The transport's own rules (design §8): three tries with jittered backoff for idempotent calls and runs with a client
// job id, a 429 or 5xx after them as RATE_LIMITED/UNAVAILABLE, eight requests in flight per process, one fresh token
// after a 401, and Google's failures as the plugin's codes with Google's words only in googleError (design §5.6).
import { describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { createHttp, MAX_RESPONSE_BYTES, retryAfter } from "../../../src/process/http.js"
import { googleError, replay } from "../../fake/bigquery.js"
import { fixture, jobsPath, portFor, routedFetch, testAuth, withFake } from "./support.js"

const TABLE = "/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_table"
const table = { tableReference: { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }, type: "TABLE" }
const signal = () => new AbortController().signal
const fastRetry = { tries: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: false }

describe("transport", () => {
  test("retries a 503 twice and returns the third answer", async () => {
    await withFake(async (fake) => {
      fake.enqueue({ method: "GET", path: TABLE }, { status: 503, body: googleError(503, "backendError", "Backend error. Job aborted.").body }, { status: 503, body: googleError(503, "backendError", "Backend error. Job aborted.").body }, { status: 200, body: table })
      const { port } = portFor(fake)
      const answer = await port.getTable("default", { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }, signal())
      expect(answer.type).toBe("TABLE")
      expect(fake.requests).toHaveLength(3)
    })
  })

  test("does not retry a rejected request, and keeps Google's message out of the error's own text", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("error-invalid-query"))
      const { port } = portFor(fake)
      const error = (await port.dryRun({ account: "default", project: "invented-project", sql: "SELECT FROM" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error).toBeInstanceOf(BigQueryError)
      expect(error.code).toBe("JOB_FAILED")
      expect(error.detail).not.toContain("Syntax error")
      expect(error.message).not.toContain("Syntax error")
      expect(error.extras.googleError).toMatchObject({ reason: "invalidQuery", location: "query", trust: "untrusted" })
      expect(error.extras.googleError?.message).toContain("Syntax error")
      expect(fake.requests).toHaveLength(1)
    })
  })

  test("a 403 rateLimitExceeded after three tries is RATE_LIMITED, with Google's Retry-After in seconds", async () => {
    await withFake(async (fake) => {
      const path = "/bigquery/v2/projects/invented-project/queries/oc_00000000-0000-4000-8000-000000000009"
      fake.answer({ method: "GET", path }, fixture("error-rate-limited").response)
      const { port } = portFor(fake)
      const error = (await port.results("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000009", location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("RATE_LIMITED")
      expect(error.state).toBe("failed")
      expect(error.extras.retryAfterSec).toBe(2)
      // 403 is not a permission error here: Google's reason wins, and a rate limit is retried (M-3).
      expect(fake.requests).toHaveLength(3)
    })
  })

  test("a 5xx with a proxy's HTML body is retried before it is parsed (L-1)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("error-proxy-503"))
      fake.answer({ method: "GET", path: "/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_proxy_table" }, { status: 200, body: { tableReference: { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_proxy_table" }, type: "TABLE" } })
      const { port } = portFor(fake)
      const table = await port.getTable("default", { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_proxy_table" }, signal())
      expect(table.type).toBe("TABLE")
      expect(fake.requests).toHaveLength(2)
    })
  })

  test("a 5xx after three tries is UNAVAILABLE", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: TABLE }, fixture("error-backend").response)
      const { port } = portFor(fake)
      const error = (await port.getTable("default", { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("UNAVAILABLE")
      expect(fake.requests).toHaveLength(3)
    })
  })

  test("a network failure is retried three times, then UNAVAILABLE", async () => {
    let attempts = 0
    const http = createHttp({
      auth: testAuth(),
      fetch: (() => {
        attempts += 1
        return Promise.reject(new TypeError("fetch failed"))
      }) as unknown as typeof globalThis.fetch,
      retry: fastRetry,
    })
    const error = (await http.request({ account: "default", method: "GET", path: "/projects", task: "your projects", signal: signal(), idempotent: true }).catch((thrown: unknown) => thrown)) as BigQueryError
    expect(error.code).toBe("UNAVAILABLE")
    expect(attempts).toBe(3)
  })

  test("a POST without a client id is never retried", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath }, { status: 503, body: googleError(503, "backendError", "Backend error.").body })
      const http = createHttp({ auth: testAuth(), fetch: routedFetch(fake.origin), retry: fastRetry })
      const error = (await http.request({ account: "default", method: "POST", path: jobsPath, body: {}, task: "a test call", signal: signal(), idempotent: false }).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("UNAVAILABLE")
      expect(fake.requests).toHaveLength(1)
    })
  })

  test("keeps at most eight requests in flight per process", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: TABLE }, { status: 200, delayMs: 100, body: table })
      const { port } = portFor(fake)
      const ref = { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }
      await Promise.all(Array.from({ length: 12 }, () => port.getTable("default", ref, signal())))
      expect(fake.maxInFlight).toBeLessThanOrEqual(8)
      expect(fake.maxInFlight).toBeGreaterThan(1)
    })
  })

  test("a 401 gets one fresh token, and a second one is AUTH_REQUIRED", async () => {
    await withFake(async (fake) => {
      fake.enqueue({ method: "GET", path: TABLE }, { status: 401, body: googleError(401, "authError", "Invalid Credentials").body }, { status: 200, body: table })
      const { port, auth } = portFor(fake)
      const ref = { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }
      expect((await port.getTable("default", ref, signal())).type).toBe("TABLE")
      expect(auth.calls.filter((call) => call.method === "token")).toHaveLength(2)

      fake.answer({ method: "GET", path: TABLE }, { status: 401, body: googleError(401, "authError", "Invalid Credentials").body })
      const error = (await port.getTable("default", ref, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("AUTH_REQUIRED")
    })
  })

  test("maps Google's failures: permission, API disabled, quota, not found", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: TABLE }, fixture("error-permission-denied").response)
      const { port } = portFor(fake)
      const ref = { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }
      expect(((await port.getTable("default", ref, signal()).catch((thrown: unknown) => thrown)) as BigQueryError).code).toBe("PERMISSION_DENIED")

      fake.answer({ method: "POST", path: jobsPath, dryRun: true }, fixture("error-api-disabled").response)
      expect(((await port.dryRun({ account: "default", project: "invented-project", sql: "SELECT 1" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError).code).toBe("API_DISABLED")

      fake.answer({ method: "GET", path: jobsPath }, { status: 403, body: googleError(403, "quotaExceeded", "Quota exceeded: your project exceeded quota for free query bytes scanned.").body })
      expect(((await port.listJobs({ account: "default", project: "invented-project" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError).code).toBe("QUOTA_EXCEEDED")

      fake.answer({ method: "GET", path: `${TABLE.replace("invented_table", "invented_missing")}` }, fixture("error-not-found").response)
      expect(((await port.getTable("default", { ...ref, tableId: "invented_missing" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError).code).toBe("NOT_FOUND")
    })
  })

  test("refuses to parse an answer over 10 MiB", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: TABLE }, { status: 200, body: "x".repeat(MAX_RESPONSE_BYTES + 1) })
      const { port } = portFor(fake)
      const error = (await port.getTable("default", { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("UNAVAILABLE")
      expect(error.detail).toContain("10 MiB")
    })
  })

  test("reads Retry-After as seconds or as an HTTP date", () => {
    expect(retryAfter(new Headers({ "retry-after": "2" }))).toBe(2)
    expect(retryAfter(new Headers({ "retry-after": "0" }))).toBe(0)
    expect(retryAfter(new Headers())).toBeUndefined()
    const later = new Date(Date.now() + 5_000).toUTCString()
    const seconds = retryAfter(new Headers({ "retry-after": later }))!
    expect(seconds).toBeGreaterThanOrEqual(3)
    expect(seconds).toBeLessThanOrEqual(5)
  })
})
