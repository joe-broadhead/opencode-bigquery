/** Shared pieces for the runtime's unit tests: the fake, a routed fetch, a port, and the fixtures. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BigQueryError } from "../../../src/domain/errors.js"
import type { QueryJobRequest, RunRequest } from "../../../src/ports.js"
import { loadOptions } from "../../../src/options.js"
import { createBigQueryPort, type BigQueryDeps } from "../../../src/process/bigquery.js"
import { FakeAuth, readRecord } from "../../fake/ports.js"
import { startFake, type BigQueryFake, type Fixture } from "../../fake/bigquery.js"

const FIXTURES = fileURLToPath(new URL("../../fixtures/google/", import.meta.url))

/** An invented fixture, by file name. */
export function fixture(name: string): Fixture {
  return { ...(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Omit<Fixture, "name">), name }
}

/**
 * `fetch` as the plugin sees it, with Google's two hosts pointed at the fake and every other host refused. It is the
 * unit tests' version of the host tests' router (test/host/route-fetch.ts), so no test can reach Google.
 */
export function routedFetch(origin: string): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname !== "bigquery.googleapis.com" && url.hostname !== "oauth2.googleapis.com") {
      return Promise.reject(new Error(`EXTERNAL_FETCH_BLOCKED: the runtime tests do not allow requests to ${url.origin}`))
    }
    return fetch(new Request(`${origin}${url.pathname}${url.search}`, request), { redirect: "error" })
  }) as typeof globalThis.fetch
}

/** A run's invented job id, the one most fixtures answer. */
export const JOB = "oc_00000000-0000-4000-8000-000000000001"
export const PROJECT = "invented-project"
export const jobsPath = `/bigquery/v2/projects/${PROJECT}/jobs`
export const cancelPath = (jobId = JOB) => `${jobsPath}/${jobId}/cancel`
export const resultsPath = (jobId = JOB) => `/bigquery/v2/projects/${PROJECT}/queries/${jobId}`

/** An account, with the Day 0 fake's interactive sign-in record. */
export function testAuth(): FakeAuth {
  return new FakeAuth({ default: { mode: "interactive", record: readRecord(), refreshScopes: [] } })
}

/** The real port against the fake, with retry delays short enough for a test. */
export function portFor(fake: BigQueryFake, overrides: Partial<BigQueryDeps> = {}) {
  const auth = testAuth()
  const port = createBigQueryPort({
    options: loadOptions({}),
    auth,
    fetch: routedFetch(fake.origin),
    retry: { tries: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: false },
    ...overrides,
  })
  return { port, auth }
}

/** Runs `body` against a fresh fake, and closes it whatever happens. */
export async function withFake<T>(body: (fake: BigQueryFake) => Promise<T>): Promise<T> {
  const fake = await startFake()
  try {
    return await body(fake)
  } finally {
    await fake.close()
  }
}

export function queryRequest(overrides: Partial<QueryJobRequest> = {}): QueryJobRequest {
  return { account: "default", project: PROJECT, sql: "SELECT id FROM `invented-project.invented_dataset.invented_table`", ...overrides }
}

export function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ...queryRequest(),
    jobId: JOB,
    location: "EU",
    maximumBytesBilled: 10 * 2 ** 30,
    jobTimeoutMs: 600_000,
    labels: { oc_plugin: "bigquery", oc_tool: "bigquery_query", oc_session: "inventedhash" },
    ...overrides,
  }
}

/**
 * Design §5.1 steps 2 and 9 at the port's boundary: the dry run, the guard that refuses an answer without statistics
 * (`DRY_RUN_INCOMPLETE`, package C's), then the run pinned to the dry run's location. Package C's handler is this order
 * plus the guards between the two calls; the runtime's tests keep its port-side facts honest until then.
 */
export async function dryRunThenRun(port: ReturnType<typeof portFor>["port"], request: QueryJobRequest, signal: AbortSignal, overrides: Partial<RunRequest> = {}) {
  const dry = await port.dryRun(request, signal)
  if (dry.statistics === undefined) throw new BigQueryError("DRY_RUN_INCOMPLETE", "The dry run returned no query statistics")
  return port.run(runRequest({ ...request, location: dry.location, ...overrides }), signal)
}
