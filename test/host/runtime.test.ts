// The runtime in an embedded OpenCode host (design §14.3, Stop): the real port drives Google's two hosts through the
// host's fetch router to a loopback fake, so the request carries the host's own fetch; and a stopped call aborts its
// request and cancels the job it started, which is the jobs.cancel the fake sees. Nothing leaves the machine.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { BigQueryError } from "../../src/domain/errors.js"
import { loadOptions } from "../../src/options.js"
import { createBigQueryPort } from "../../src/process/bigquery.js"
import { convertRows } from "../../src/process/values.js"
import type { SchemaField } from "../../src/domain/google.js"
import { dryRunOf, pending, replay, startFake, type Fixture } from "../fake/bigquery.js"
import { FakeAuth, readRecord } from "../fake/ports.js"
import { cleanup, startHost, until } from "./harness.js"

afterAll(cleanup)

const PROJECT = "invented-project"
const JOB = "oc_00000000-0000-4000-8000-000000000001"
const jobs = `/bigquery/v2/projects/${PROJECT}/jobs`
const results = `/bigquery/v2/projects/${PROJECT}/queries/${JOB}`
const cancel = `${jobs}/${JOB}/cancel`

const fixture = (name: string): Fixture => ({ name, ...(JSON.parse(readFileSync(new URL(`../fixtures/google/${name}.json`, import.meta.url), "utf8")) as Omit<Fixture, "name">) })

/** The real port, with the host's routed `fetch` and the Day 0 fake account. */
function port() {
  return createBigQueryPort({
    options: loadOptions({}),
    auth: new FakeAuth({ default: { mode: "interactive", record: readRecord(), refreshScopes: [] } }),
    fetch: globalThis.fetch,
    retry: { tries: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: false },
  })
}

const query = { account: "default", project: PROJECT, sql: "SELECT id FROM `invented-project.invented_dataset.invented_table`" }

describe("the runtime in a host", () => {
  test("drives a dry run, a run and its results through the host's fetch, with nothing off the machine", async () => {
    const fake = await startFake()
    replay(fake, fixture("dry-run-select"))
    replay(fake, fixture("job-running"))
    replay(fake, fixture("results-page-1"))
    const host = await startHost({ fake })
    try {
      const bigquery = port()
      const signal = new AbortController().signal
      const dry = await bigquery.dryRun(query, signal)
      const run = await bigquery.run({ ...query, jobId: JOB, location: dry.location, maximumBytesBilled: 10 * 2 ** 30, jobTimeoutMs: 600_000, labels: { oc_plugin: "bigquery", oc_tool: "bigquery_query" } }, signal)
      const page = await bigquery.results("default", run.ref, { timeoutMs: 30_000, maxResults: 51 }, signal)

      expect(dry.location).toBe("EU")
      expect(run.state).toBe("RUNNING")
      expect(page.totalRows).toBe(3)
      const rows = convertRows(page.schema as readonly SchemaField[], page.rows)
      expect(rows[0]![0]).toBe(1)
      expect(rows[0]![1]).toBe("9007199254740993")

      expect(fake.requests).toHaveLength(3)
      for (const request of fake.requests) expect(request.headers.authorization).toBe("sent")
      expect(dryRunOf(fake.requests[0]!.body)).toBe(true)
      expect((fake.requests[1]!.body as { jobReference: { jobId: string } }).jobReference.jobId).toBe(JOB)
      expect(fake.requests[1]!.path).toBe(jobs)
      expect(fake.requests[2]!.path).toBe(results)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a stopped call cancels the job it started, and the answer is CANCELLED", async () => {
    const fake = await startFake()
    replay(fake, fixture("job-running"))
    const resultsPath = `/bigquery/v2/projects/${PROJECT}/queries/${JOB}`
    fake.answer({ method: "GET", path: resultsPath }, { status: 200, body: pending() })
    fake.answer({ method: "POST", path: cancel }, { status: 200, body: { jobReference: { projectId: PROJECT, jobId: JOB, location: "EU" }, status: { state: "DONE" } } })
    const host = await startHost({ fake })
    try {
      const bigquery = port()
      const run = await bigquery.run({ ...query, jobId: JOB, location: "EU", maximumBytesBilled: 10 * 2 ** 30, jobTimeoutMs: 600_000, labels: { oc_plugin: "bigquery" } }, new AbortController().signal)
      const controller = new AbortController()

      const call = bigquery.results("default", run.ref, { timeoutMs: 30_000, maxResults: 51 }, controller.signal)
      await until("the results request reached the fake", async () => fake.requests.some((request) => request.method === "GET" && request.path === resultsPath))
      controller.abort()
      const error = (await call.catch((thrown: unknown) => thrown)) as BigQueryError

      expect(error).toBeInstanceOf(BigQueryError)
      expect(error.code).toBe("CANCELLED")
      expect(fake.requests.some((request) => request.method === "POST" && request.path === cancel)).toBe(true)
    } finally {
      await host.close()
    }
  }, 120_000)
})
