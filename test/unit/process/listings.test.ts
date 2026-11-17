// The listings and metadata reads of design §4 and §5.1 at the port's boundary: every answer becomes the domain type
// the guards and tools read, Google's int64 strings are kept where the type says text, and a refused call is the
// plugin's code for it (a 403 on rowAccessPolicies.list is PERMISSION_DENIED, which sends the guards to the probe).
// The shapes are the pages' projections: a tables.list item has no size, and routines.list needs a readMask for its
// body and arguments.
import { describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { googleError, replay } from "../../fake/bigquery.js"
import { fixture, portFor, withFake } from "./support.js"

const signal = () => new AbortController().signal
const TABLE = { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }
const DATASET = { projectId: "invented-project", datasetId: "invented_dataset" }

describe("listings and metadata", () => {
  test("projects and datasets, with their page tokens", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("projects-list"))
      replay(fake, fixture("datasets-list"))
      const { port } = portFor(fake)

      await expect(port.listProjects({ account: "default" }, signal())).resolves.toEqual({
        items: [
          { projectId: "invented-project", friendlyName: "Invented project" },
          { projectId: "invented-project-two", friendlyName: "Invented project two" },
        ],
      })
      await expect(port.listDatasets({ account: "default", project: "invented-project" }, signal())).resolves.toEqual({
        items: [
          { ref: { projectId: "invented-project", datasetId: "invented_dataset" }, location: "EU" },
          { ref: { projectId: "invented-project", datasetId: "invented_second" }, location: "EU" },
        ],
        nextPageToken: "invented-dataset-page-2",
      })
      expect(fake.requests[0]!.path).toBe("/bigquery/v2/projects")
      expect(fake.requests[1]!.path).toBe("/bigquery/v2/projects/invented-project/datasets")
    })
  })

  test("tables: the list's projection, then the Table resource's size and partitioning", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("tables-list"))
      replay(fake, fixture("table-get"))
      const { port } = portFor(fake)

      const list = await port.listTables({ account: "default", dataset: DATASET, maxResults: 10 }, signal())
      expect(list.items.map((item) => item.type)).toEqual(["TABLE", "VIEW"])
      // tables.list answers no size and no location: those come from tables.get, as bigquery_list({ details: true }) does.
      expect(list.items[0]).toMatchObject({ timePartitioning: { type: "DAY", field: "day" }, clustering: { fields: ["name"] }, requirePartitionFilter: true })
      expect(list.items[0]).not.toHaveProperty("numBytes")
      expect(list.nextPageToken).toBe("invented-table-page-2")

      const table = await port.getTable("default", TABLE, signal())
      expect(table).toMatchObject({
        type: "TABLE",
        location: "EU",
        numBytes: "1048576",
        numRows: "1200",
        lastModifiedTime: "1763377200000",
        timePartitioning: { type: "DAY", field: "day" },
        clustering: { fields: ["name"] },
        requirePartitionFilter: true,
        description: "An invented table, not real data.",
      })
      expect(table.schema?.fields?.map((field) => field.name)).toEqual(["id", "name", "ssn", "address", "tags"])
      expect(table.schema?.fields?.[2]?.policyTags?.names).toHaveLength(1)
    })
  })

  test("table data: the caller's fields and page size go on the wire, with exact timestamps", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("table-data"))
      const { port } = portFor(fake)
      const page = await port.listTableData("default", TABLE, { maxResults: 2, selectedFields: ["id", "name"] }, signal())
      expect(page).toMatchObject({ complete: false, totalRows: 1200, pageToken: "invented-data-page-2" })
      expect(page.rows).toHaveLength(2)
      expect((page.rows[0] as { f: { v: unknown }[] }).f[1]!.v).toBe("alpha")
      expect(fake.requests[0]!.query).toMatchObject({ maxResults: "2", selectedFields: "id,name", "formatOptions.useInt64Timestamp": "true" })
    })
  })

  test("routines: the list asks for the body and arguments a listing otherwise omits", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("routines-list"))
      replay(fake, fixture("routine-get"))
      const { port } = portFor(fake)
      const list = await port.listRoutines({ account: "default", dataset: DATASET }, signal())
      expect(list.items).toHaveLength(2)
      expect(list.items[1]).toMatchObject({ language: "PYTHON", remoteFunctionOptions: { endpoint: "https://invented.invalid/v1" } })
      expect(list.items[0]).toMatchObject({ language: "SQL", definitionBody: "x * 2", arguments: [{ name: "x", dataType: { typeKind: "INT64" } }] })
      expect(fake.requests[0]!.query.readMask).toContain("arguments")
      const routine = await port.getRoutine("default", { projectId: "invented-project", datasetId: "invented_dataset", routineId: "invented_routine" }, signal())
      expect(routine).toMatchObject({ routineType: "SCALAR_FUNCTION", language: "SQL", definitionBody: "x * 2" })
    })
  })

  test("row access policies: the id is nested, and a Data Viewer's 403 is PERMISSION_DENIED", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("row-access-policies"))
      const { port } = portFor(fake)
      await expect(port.listRowAccessPolicies("default", TABLE, signal())).resolves.toEqual({ items: [{ policyId: "invented_policy" }] })
      expect(fake.requests[0]!.query).toMatchObject({ pageSize: "1000" })

      fake.answer({ method: "GET", path: "/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_table/rowAccessPolicies" }, googleError(403, "accessDenied", "Access Denied: User does not have bigquery.rowAccessPolicies.list permission on table."))
      const error = (await port.listRowAccessPolicies("default", TABLE, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("PERMISSION_DENIED")
    })
  })

  test("testIamPermissions names the permissions it asks about, on the colon path", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("test-iam-permissions"))
      const { port } = portFor(fake)
      const held = await port.testTablePermissions("default", TABLE, ["bigquery.tables.updateData", "bigquery.tables.create"], signal())
      expect(held).toEqual(["bigquery.tables.getData"])
      expect(fake.requests[0]!.path).toBe("/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_table:testIamPermissions")
      expect((fake.requests[0]!.body as { permissions: string[] }).permissions).toEqual(["bigquery.tables.updateData", "bigquery.tables.create"])
    })
  })

  test("jobs: the listing asks for the account's own finished jobs, and carries each job's own location", async () => {
    await withFake(async (fake) => {
      fake.answer(
        { method: "GET", path: "/bigquery/v2/projects/invented-project/jobs" },
        {
          status: 200,
          body: {
            kind: "bigquery#jobList",
            etag: "invented-etag",
            jobs: [
              {
                id: "invented-project:EU.oc_00000000-0000-4000-8000-0000000000b1",
                jobReference: { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-0000000000b1", location: "EU" },
                state: "DONE",
                configuration: { jobType: "QUERY", query: { query: "SELECT 1" } },
                statistics: { creationTime: "1763377200000", endTime: "1763377201000", query: { statementType: "SELECT", totalBytesBilled: "10485760" } },
                status: { state: "DONE" },
              },
              { jobReference: { projectId: "invented-project", location: "EU" }, status: { state: "DONE" } },
            ],
            nextPageToken: "invented-jobs-page-2",
          },
        },
      )
      const { port } = portFor(fake)
      const page = await port.listJobs({ account: "default", project: "invented-project", stateFilter: "done", maxResults: 100 }, signal())
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ ref: { jobId: "oc_00000000-0000-4000-8000-0000000000b1", location: "EU" }, state: "DONE", statementType: "SELECT", totalBytesBilled: 10485760, sqlPreview: "SELECT 1" })
      expect(page.nextPageToken).toBe("invented-jobs-page-2")
      expect(fake.requests[0]!.query).toMatchObject({ allUsers: "false", stateFilter: "DONE", projection: "FULL", maxResults: "100" })
    })
  })

  test("jobs: a page with no maxResults is bounded, so a full projection cannot pass 10 MiB", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "GET", path: "/bigquery/v2/projects/invented-project/jobs" }, { status: 200, body: { kind: "bigquery#jobList", jobs: [] } })
      const { port } = portFor(fake)
      await port.listJobs({ account: "default", project: "invented-project" }, signal())
      expect(fake.requests[0]!.query.maxResults).toBe("100")
    })
  })

  test("a missing table is NOT_FOUND, and cancelling a job answers the job Google reports", async () => {
    await withFake(async (fake) => {
      replay(fake, fixture("error-not-found"))
      fake.answer({ method: "POST", path: "/bigquery/v2/projects/invented-project/jobs/oc_00000000-0000-4000-8000-0000000000c1/cancel" }, { status: 200, body: { kind: "bigquery#jobCancelResponse", job: { jobReference: { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-0000000000c1", location: "EU" }, status: { state: "DONE" } } } })
      const { port } = portFor(fake)

      const error = (await port.getTable("default", { ...TABLE, tableId: "invented_missing" }, signal()).catch((thrown: unknown) => thrown)) as BigQueryError
      expect(error.code).toBe("NOT_FOUND")
      expect(error.extras.googleError?.reason).toBe("notFound")

      const cancelled = await port.cancel("default", { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-0000000000c1", location: "EU" }, signal())
      expect(cancelled.state).toBe("DONE")
      const request = fake.requests.at(-1)!
      expect(request.body).toBeUndefined()
      expect(request.query).toMatchObject({ location: "EU" })
    })
  })
})
