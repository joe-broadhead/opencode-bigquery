// Design §14.1, the read-path order, and live checks L3 and L8, at the port's boundary: a dry run that is
// jobs.insert with the exact text and parameters, a run that is pinned to the dry run's location and carries the client
// job id, cap, labels and time limit with no destination or session, and a dry run without statistics.query that runs
// nothing. Package C's handler is this order with the guards in between; these are the facts it relies on.
import { describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { dryRunOf, replay } from "../../fake/bigquery.js"
import { dryRunThenRun, fixture, jobsPath, portFor, queryRequest, runRequest, withFake } from "./support.js"

const signal = () => new AbortController().signal

describe("read path order", () => {
  test("no run without a fully answered dry run", async () => {
    await withFake(async (fake) => {
      // A dry run that answered without statistics.query: what the API would send for a query it did not analyse.
      fake.answer({ method: "POST", path: jobsPath, dryRun: true }, { status: 200, body: { jobReference: { projectId: "invented-project", location: "EU" }, status: { state: "DONE" } } })
      const { port } = portFor(fake)

      const refusal = await dryRunThenRun(port, queryRequest(), signal()).catch((error: unknown) => error)

      expect(refusal).toBeInstanceOf(BigQueryError)
      expect((refusal as BigQueryError).code).toBe("DRY_RUN_INCOMPLETE")
      // The dry run was the only jobs.insert: nothing ran without the statistics the guards check.
      const inserts = fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/jobs"))
      expect(inserts).toHaveLength(1)
      expect(dryRunOf(inserts[0]!.body)).toBe(true)
    })
  })

  test("a dry run's statistics: statement type, accuracy, all four referenced lists and the result schema (L3)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("dry-run-select"))
      const { port } = portFor(fake)

      const dry = await port.dryRun(queryRequest(), signal())

      expect(dry.location).toBe("EU")
      expect(dry.statistics).toMatchObject({
        statementType: "SELECT",
        totalBytesProcessed: "987654321",
        totalBytesProcessedAccuracy: "PRECISE",
        schema: { fields: [{ name: "id", type: "INT64" }, { name: "name", type: "STRING" }] },
      })
      expect(dry.statistics?.referencedTables).toHaveLength(2)
      expect(dry.statistics?.referencedLogicalViews).toHaveLength(1)
      expect(dry.statistics?.referencedRoutines).toHaveLength(1)
      expect(dry.statistics?.referencedPropertyGraphs).toEqual([{ projectId: "invented-project", datasetId: "invented_dataset", propertyGraphId: "invented_graph" }])
    })
  })

  test("a table's partitions ride the same read path: INFORMATION_SCHEMA.PARTITIONS is a dry run and a run (contract PR #5)", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("dry-run-partitions"))
      replay(fake, fixture("job-running"))
      const { port } = portFor(fake)
      const sql =
        "SELECT partition_id, total_rows, total_logical_bytes FROM `invented-project.invented_dataset.INFORMATION_SCHEMA.PARTITIONS` WHERE table_name = 'invented_table'"

      const status = await dryRunThenRun(port, queryRequest({ sql, location: "EU" }), signal())

      expect(status.state).toBe("RUNNING")
      const inserts = fake.requests.filter((request) => request.method === "POST" && request.path === jobsPath)
      expect(inserts).toHaveLength(2)
      expect((inserts[1]!.body as { configuration: { query: { query: string } } }).configuration.query.query).toBe(sql)
      // The dry run's 10 MB minimum is what the guards see; nothing here treats it as free.
      expect(fake.requests[0]!.query).toEqual({})
    })
  })

  test("every run carries the client job id, the cap, the labels and the time limit, and no destination or session", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("dry-run-select"))
      replay(fake, fixture("job-running"))
      const { port } = portFor(fake)

      await dryRunThenRun(port, queryRequest(), signal())

      const run = fake.requests.find((request) => request.method === "POST" && request.path === jobsPath && dryRunOf(request.body) === false)
      expect(run).toBeDefined()
      const body = run!.body as {
        jobReference: Record<string, unknown>
        configuration: { query: Record<string, unknown>; dryRun: boolean; jobTimeoutMs: string; labels: Record<string, string>; [key: string]: unknown }
      }
      expect(body.jobReference).toEqual({ projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000001", location: "EU" })
      expect(body.configuration.dryRun).toBe(false)
      expect(body.configuration.jobTimeoutMs).toBe("600000")
      expect(body.configuration.query.maximumBytesBilled).toBe(String(10 * 2 ** 30))
      expect(body.configuration.labels).toEqual({ oc_plugin: "bigquery", oc_tool: "bigquery_query", oc_session: "inventedhash" })
      // Nothing that would make a read a change, whatever the caller passed.
      expect(Object.keys(body.configuration).sort()).toEqual(["dryRun", "jobTimeoutMs", "labels", "query"])
      for (const forbidden of ["destinationTable", "writeDisposition", "createSession", "connectionProperties", "tableDefinitions", "schemaUpdateOptions"]) {
        expect(body.configuration.query, forbidden).not.toHaveProperty(forbidden)
        expect(body.configuration, forbidden).not.toHaveProperty(forbidden)
      }
    })
  })

  test("byte-identical SQL, parameters and default dataset in the dry run and the run", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: jobsPath, dryRun: true }, { status: 200, body: { jobReference: { projectId: "invented-project", location: "EU" }, statistics: { query: { statementType: "SELECT", totalBytesProcessed: "1" } }, status: { state: "DONE" } } })
      replay(fake, fixture("job-running"))
      const { port } = portFor(fake)
      const request = queryRequest({
        sql: "SELECT @id AS id",
        params: [{ name: "id", parameterType: { type: "INT64" }, parameterValue: { value: "1" } }],
        defaultDataset: { projectId: "invented-project", datasetId: "invented_dataset" },
      })

      await dryRunThenRun(port, request, signal())

      const inserts = fake.requests.filter((entry) => entry.method === "POST" && entry.path === jobsPath)
      const queries = inserts.map((entry) => {
        const query = (entry.body as { configuration: { query: Record<string, unknown> } }).configuration.query
        return JSON.stringify({ query: query.query, queryParameters: query.queryParameters, parameterMode: query.parameterMode, defaultDataset: query.defaultDataset })
      })
      expect(inserts).toHaveLength(2)
      expect(queries[1]).toBe(queries[0])
      expect(JSON.parse(queries[0]!)).toMatchObject({
        query: "SELECT @id AS id",
        parameterMode: "NAMED",
        queryParameters: [{ name: "id", parameterType: { type: "INT64" }, parameterValue: { value: "1" } }],
        defaultDataset: { projectId: "invented-project", datasetId: "invented_dataset" },
      })
    })
  })

  test("uses the location the dry run chose, and none when it chose none (L8)", async () => {
    await withFake(async (fake) => {
      maybeLocation(fake, "EU")
      replay(fake, fixture("job-running"))
      const { port } = portFor(fake)
      await dryRunThenRun(port, queryRequest(), signal())
      const dry = fake.requests.find((request) => request.method === "POST" && dryRunOf(request.body) === true)!
      // Nothing was passed, so Google infers the location; the run then pins what it answered.
      expect((dry.body as { jobReference: Record<string, unknown> }).jobReference).not.toHaveProperty("location")
      const run = fake.requests.find((request) => request.method === "POST" && dryRunOf(request.body) === false)!
      expect((run.body as { jobReference: { location?: string } }).jobReference.location).toBe("EU")
    })

    await withFake(async (fake) => {
      maybeLocation(fake, undefined)
      fake.answer({ method: "POST", path: jobsPath, dryRun: false }, { status: 200, body: { jobReference: { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000001" }, status: { state: "RUNNING" } } })
      const { port } = portFor(fake)
      await port.run(runRequest({ location: "" }), signal())
      const run = fake.requests.find((request) => request.method === "POST" && dryRunOf(request.body) === false)!
      expect((run.body as { jobReference: Record<string, unknown> }).jobReference).not.toHaveProperty("location")
    })
  })

  test("a result page is asked for at the pinned location, and its rows and page token are passed through", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("results-page-1"))
      const { port } = portFor(fake)
      const page = await port.results("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000001", location: "EU" }, { timeoutMs: 30_000, maxResults: 51 }, signal())
      expect(page).toMatchObject({ complete: true, totalRows: 3, pageToken: "invented-results-page-2" })
      expect(page.rows).toHaveLength(3)
      const request = fake.requests[0]!
      expect(request.query).toMatchObject({ timeoutMs: "30000", maxResults: "51", location: "EU" })
    })
  })

  test("paging follows the token to a last page with none", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("results-page-1"))
      replay(fake, fixture("results-page-2"))
      const { port } = portFor(fake)
      const ref = { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000001", location: "EU" }
      const first = await port.results("default", ref, { timeoutMs: 30_000, maxResults: 51 }, signal())
      const second = await port.results("default", ref, { timeoutMs: 30_000, maxResults: 51, pageToken: first.pageToken }, signal())
      expect(first.pageToken).toBe("invented-results-page-2")
      expect(second.pageToken).toBeUndefined()
      expect(second.complete).toBe(true)
      expect(fake.requests[1]!.query).toMatchObject({ pageToken: "invented-results-page-2" })
    })
  })

  test("a job answered in another location reports that location, so the read path can refuse the mismatch (L8)", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: `${jobsPath}/oc_00000000-0000-4000-8000-000000000004` }, { status: 200, body: { jobReference: { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000004", location: "US" }, status: { state: "DONE" } } })
      const { port } = portFor(fake)
      const status = await port.getJob("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000004", location: "EU" }, signal())
      expect(status.ref.location).toBe("US")
    })
  })
})

/** A dry-run answer whose jobReference carries `location`, or none at all. */
function maybeLocation(fake: Parameters<typeof replay>[0], location: string | undefined) {
  fake.answer(
    { method: "POST", path: jobsPath, dryRun: true },
    {
      status: 200,
      body: {
        jobReference: { projectId: "invented-project", ...(location !== undefined ? { location } : {}) },
        statistics: { query: { statementType: "SELECT", totalBytesProcessed: "1", totalBytesProcessedAccuracy: "PRECISE" } },
        status: { state: "DONE" },
      },
    },
  )
}
