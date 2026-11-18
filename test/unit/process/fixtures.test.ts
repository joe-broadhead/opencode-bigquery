// Each fixture against the page it cites: the top-level keys, the list entries' keys and, for the value page, the
// schema's field names all come from Google's REST reference, so a fixture cannot quietly invent a field the API does
// not have (review bigquery-2, L-6). The field lists and their pages are also in test/fixtures/google/README.md.
import { describe, expect, test } from "vitest"
import { contractViolation, dryRunOf, loadFixtures, matches } from "../../fake/bigquery.js"

const fixtures = loadFixtures()
const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]))

/** Page and documented top-level fields per fixture. */
const DOCS: Readonly<Record<string, { readonly page: string; readonly keys: readonly string[] }>> = {
  "projects-list": { page: "projects/list", keys: ["kind", "etag", "nextPageToken", "projects", "totalItems"] },
  "datasets-list": { page: "datasets/list", keys: ["kind", "etag", "nextPageToken", "datasets", "totalItems"] },
  "tables-list": { page: "tables/list", keys: ["kind", "etag", "nextPageToken", "tables", "totalItems"] },
  "table-get": {
    page: "tables",
    keys: [
      "kind", "etag", "id", "selfLink", "tableReference", "friendlyName", "description", "labels", "schema", "timePartitioning",
      "rangePartitioning", "clustering", "requirePartitionFilter", "numBytes", "numLongTermBytes", "numRows", "creationTime",
      "expirationTime", "lastModifiedTime", "type", "view", "materializedView", "externalDataConfiguration", "biglakeConfiguration",
      "location", "streamingBuffer", "cloneDefinition", "tableConstraints",
    ],
  },
  "table-data": { page: "tabledata/list", keys: ["kind", "etag", "totalRows", "pageToken", "rows"] },
  "routines-list": { page: "routines/list", keys: ["routines", "nextPageToken"] },
  "routine-get": { page: "routines", keys: ["kind", "etag", "routineReference", "routineType", "creationTime", "lastModifiedTime", "language", "arguments", "definitionBody", "remoteFunctionOptions"] },
  "row-access-policies": { page: "rowAccessPolicies/list", keys: ["rowAccessPolicies", "nextPageToken"] },
  "test-iam-permissions": { page: "tables/testIamPermissions", keys: ["permissions"] },
  "dry-run-select": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-partitions": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-create-table": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-alter-rename": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-drop-row-access-policy": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-create-function": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-create-schema": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-grant-table": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-grant-view": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "dry-run-grant-schema": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "job-running": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "job-done": { page: "Job", keys: ["kind", "etag", "id", "jobReference", "configuration", "statistics", "status"] },
  "job-bytes-billed": { page: "Job", keys: ["kind", "id", "jobReference", "configuration", "statistics", "status"] },
  "job-bytes-billed-get": { page: "Job", keys: ["kind", "id", "jobReference", "configuration", "statistics", "status"] },
  "job-timeout": { page: "Job", keys: ["kind", "id", "jobReference", "configuration", "statistics", "status"] },
  "results-page-1": { page: "jobs/getQueryResults", keys: ["kind", "etag", "schema", "jobReference", "totalRows", "pageToken", "rows", "totalBytesProcessed", "jobComplete", "errors", "cacheHit", "numDmlAffectedRows"] },
  "results-page-2": { page: "jobs/getQueryResults", keys: ["kind", "etag", "schema", "jobReference", "totalRows", "pageToken", "rows", "totalBytesProcessed", "jobComplete", "errors", "cacheHit", "numDmlAffectedRows"] },
  "results-warning": { page: "jobs/getQueryResults", keys: ["kind", "jobReference", "totalRows", "rows", "totalBytesProcessed", "jobComplete", "errors", "cacheHit", "schema"] },
  "error-duplicate": { page: "error messages", keys: ["error"] },
  "error-invalid-query": { page: "error messages", keys: ["error"] },
  "error-permission-denied": { page: "error messages", keys: ["error"] },
  "error-api-disabled": { page: "error messages", keys: ["error"] },
  "error-rate-limited": { page: "error messages", keys: ["error"] },
  "error-backend": { page: "error messages", keys: ["error"] },
  "error-proxy-503": { page: "error messages", keys: [] },
  "error-not-found": { page: "error messages", keys: ["error"] },
  "error-bytes-billed-400": { page: "error messages", keys: ["error"] },
  "error-timeout-400": { page: "error messages", keys: ["error"] },
  "error-job-rate-limited-400": { page: "error messages", keys: ["error"] },
}

const KEYS = {
  tableListItem: ["kind", "id", "tableReference", "friendlyName", "type", "timePartitioning", "rangePartitioning", "clustering", "hivePartitioningOptions", "labels", "view", "creationTime", "expirationTime", "requirePartitionFilter"],
  routine: ["kind", "etag", "routineReference", "routineType", "creationTime", "lastModifiedTime", "language", "arguments", "returnType", "definitionBody", "description", "determinismLevel", "importedLibraries", "remoteFunctionOptions", "sparkOptions"],
  rowAccessPolicy: ["etag", "rowAccessPolicyReference", "filterPredicate", "creationTime", "lastModifiedTime", "grantees"],
  jobReference: ["projectId", "jobId", "location"],
  jobConfiguration: ["jobType", "query", "load", "copy", "extract", "dryRun", "jobTimeoutMs", "labels", "reservation"],
  jobQuery: ["query", "destinationTable", "tableDefinitions", "userDefinedFunctionResources", "createDisposition", "writeDisposition", "defaultDataset", "priority", "preserveNulls", "allowLargeResults", "useQueryCache", "flattenResults", "maximumBillingTier", "maximumBytesBilled", "useLegacySql", "parameterMode", "queryParameters", "schemaUpdateOptions", "timePartitioning", "rangePartitioning", "clustering", "destinationEncryptionConfiguration", "scriptOptions", "connectionProperties", "createSession", "secureContext", "systemVariables"],
  queryStatistics: ["queryPlan", "estimatedBytesProcessed", "timeline", "totalPartitionsProcessed", "totalBytesProcessed", "totalBytesProcessedAccuracy", "totalBytesBilled", "billingTier", "totalSlotMs", "reservationUsage", "cacheHit", "referencedTables", "referencedRoutines", "referencedLogicalViews", "referencedPropertyGraphs", "schema", "numDmlAffectedRows", "dmlStats", "undeclaredQueryParameters", "statementType", "ddlOperationPerformed", "ddlTargetTable", "ddlDestinationTable", "ddlTargetRowAccessPolicy", "ddlAffectedRowAccessPolicyCount", "ddlTargetRoutine", "ddlTargetDataset", "dclTargetTable", "dclTargetView", "dclTargetDataset", "totalServicesSkuSlotMs"],
  tableField: ["name", "type", "mode", "fields", "description", "policyTags", "dataPolicies", "dataPolicyList", "maxLength", "precision", "scale", "roundingMode", "collation", "defaultValueExpression", "rangeElementType", "generatedColumn"],
  error: ["code", "message", "errors", "status"],
  // ErrorProto plus the fields Google's error envelope carries: domain, locationType and extendedHelp.
  errorProto: ["reason", "location", "debugInfo", "message", "domain", "locationType", "extendedHelp"],
}

/** One dry run per change field Google names in JobStatistics2 (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobstatistics2). */
const CHANGE_FIXTURES = ["dry-run-create-table", "dry-run-alter-rename", "dry-run-drop-row-access-policy", "dry-run-create-function", "dry-run-create-schema", "dry-run-grant-table", "dry-run-grant-view", "dry-run-grant-schema"]
/** Each change field's documented type: a TableReference, RoutineReference, DatasetReference or RowAccessPolicyReference. */
const CHANGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ddlTargetTable: ["datasetId", "projectId", "tableId"],
  ddlDestinationTable: ["datasetId", "projectId", "tableId"],
  dclTargetTable: ["datasetId", "projectId", "tableId"],
  dclTargetView: ["datasetId", "projectId", "tableId"],
  ddlTargetRowAccessPolicy: ["datasetId", "policyId", "projectId", "tableId"],
  ddlTargetRoutine: ["datasetId", "projectId", "routineId"],
  ddlTargetDataset: ["datasetId", "projectId"],
  dclTargetDataset: ["datasetId", "projectId"],
}

const body = (name: string) => byName.get(name)!.response.body as Record<string, unknown>
const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>).sort()
const expectWithin = (keys: readonly string[], allowed: readonly string[], what: string) =>
  expect(keys.filter((key) => !allowed.includes(key)), what).toEqual([])

describe("fixtures", () => {
  test("every fixture is documented, and its top-level keys are the page's", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(24)
    for (const fixture of fixtures) {
      const docs = DOCS[fixture.name]
      expect(docs, `${fixture.name} has no documentation row`).toBeDefined()
      const keys = docs!.keys.length === 0 ? [] : keysOf(fixture.response.body)
      expectWithin(keys, docs!.keys, `${fixture.name} (${docs!.page})`)
    }
  })

  test("a list item is the projection its page returns", () => {
    for (const table of body("tables-list").tables as Record<string, unknown>[]) expectWithin(keysOf(table), KEYS.tableListItem, "tables.list item")
    for (const routine of body("routines-list").routines as Record<string, unknown>[]) expectWithin(keysOf(routine), KEYS.routine, "routines.list item")
    for (const policy of body("row-access-policies").rowAccessPolicies as Record<string, unknown>[]) {
      expectWithin(keysOf(policy), KEYS.rowAccessPolicy, "RowAccessPolicy")
      // The id is nested: a top-level policyId is exactly the bug review bigquery-2 H-1 found.
      expect(policy).not.toHaveProperty("policyId")
      expectWithin(keysOf(policy.rowAccessPolicyReference), ["projectId", "datasetId", "tableId", "policyId"], "RowAccessPolicyReference")
    }
    for (const project of body("projects-list").projects as Record<string, unknown>[]) expectWithin(keysOf(project), ["kind", "id", "numericId", "projectReference", "friendlyName"], "projects.list item")
    for (const dataset of body("datasets-list").datasets as Record<string, unknown>[]) expectWithin(keysOf(dataset), ["kind", "id", "datasetReference", "labels", "friendlyName", "location"], "datasets.list item")
  })

  test("a Job is the Job resource, field by field", () => {
    for (const name of ["dry-run-select", "dry-run-partitions", ...CHANGE_FIXTURES, "job-running", "job-done", "job-bytes-billed", "job-bytes-billed-get", "job-timeout"]) {
      const job = body(name)
      expectWithin(keysOf(job.jobReference), KEYS.jobReference, `${name} jobReference`)
      expectWithin(keysOf(job.configuration), KEYS.jobConfiguration, `${name} configuration`)
      expectWithin(keysOf((job.configuration as Record<string, unknown>).query), KEYS.jobQuery, `${name} configuration.query`)
      expectWithin(keysOf((job.statistics as Record<string, unknown>).query), KEYS.queryStatistics, `${name} statistics.query`)
      expectWithin(keysOf(job.status), ["state", "errorResult", "errors"], `${name} status`)
    }
  })

  test("a change's dry run names its target exactly in the documented reference type", () => {
    const seen = new Set<string>()
    for (const name of CHANGE_FIXTURES) {
      const statistics = (body(name).statistics as Record<string, Record<string, unknown>>).query!
      for (const [field, value] of Object.entries(statistics)) {
        if (field.startsWith("ddlTarget") || field.startsWith("dclTarget") || field === "ddlDestinationTable") {
          expect(keysOf(value), `${name} ${field}`).toEqual(CHANGE_FIELDS[field])
          for (const id of Object.values(value as Record<string, unknown>)) expect(typeof id, `${name} ${field}`).toBe("string")
          seen.add(field)
        }
      }
      if (statistics.numDmlAffectedRows !== undefined) expect(statistics.numDmlAffectedRows).toMatch(/^\d+$/)
    }
    expect([...seen].sort()).toEqual(Object.keys(CHANGE_FIELDS).sort())
  })

  test("a result page: documented keys, documented schema fields, exact TIMESTAMPs", () => {
    for (const name of ["results-page-1", "results-page-2", "results-warning"]) {
      const page = body(name)
      for (const field of (page.schema as { fields: Record<string, unknown>[] }).fields) expectWithin(keysOf(field), KEYS.tableField, `${name} schema field`)
      const fields = (page.schema as { fields: { name: string; type: string }[] }).fields
      for (const row of page.rows as { f: { v: unknown }[] }[]) {
        expect(row.f).toHaveLength(fields.length)
        fields.forEach((field, index) => {
          const value = row.f[index]!.v
          if (field.type === "TIMESTAMP" && value !== null) {
            // formatOptions.useInt64Timestamp: microseconds, an integer, exactly (never a double in scientific form).
            expect(typeof value, `${name} ${field.name}`).toBe("string")
            expect(value as string, `${name} ${field.name}`).toMatch(/^-?\d+$/)
          }
          if (field.type === "BOOL" && value !== null) expect(["true", "false"], `${name} ${field.name}`).toContain(value)
        })
      }
    }
  })

  test("an error body is Google's `error`, with an ErrorProto", () => {
    for (const name of ["error-duplicate", "error-invalid-query", "error-permission-denied", "error-api-disabled", "error-rate-limited", "error-backend", "error-not-found", "error-bytes-billed-400", "error-timeout-400", "error-job-rate-limited-400"]) {
      const error = body(name).error as Record<string, unknown>
      expectWithin(keysOf(error), KEYS.error, name)
      expect(typeof error.code, name).toBe("number")
      expectWithin(keysOf((error.errors as Record<string, unknown>[])[0]), KEYS.errorProto, `${name} ErrorProto`)
    }
  })

  test("no real identifier, address or token survived", () => {
    for (const fixture of fixtures) {
      const text = JSON.stringify(fixture.response)
      expect(text, fixture.name).not.toMatch(/ya29\./)
      expect(text, fixture.name).not.toMatch(/googleusercontent/)
      expect(text, fixture.name).not.toMatch(/Bearer /)
      expect(text, fixture.name).not.toMatch(/@(?!example\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      expect(text, fixture.name).not.toMatch(/\/(?:Users|private)\//)
      for (const digits of text.match(/(?<![\d-])\d{12}(?![\d-])/g) ?? []) expect(digits, fixture.name).toBe("000000000000")
      for (const projectId of text.match(/"projectId":"([^"]+)"/g) ?? []) expect(projectId, fixture.name).toMatch(/"projectId":"invented-/)
    }
  })

  test("a dry-run route and a run route are told apart by their bodies", () => {
    const dry = byName.get("dry-run-select")!
    const run = byName.get("job-running")!
    expect(dry.request.dryRun).toBe(true)
    expect(run.request.dryRun).toBe(false)
    const route = { method: "POST", path: dry.request.path, dryRun: true }
    expect(matches(route, { method: "POST", path: dry.request.path, body: { configuration: { dryRun: true } } })).toBe(true)
    expect(matches(route, { method: "POST", path: dry.request.path, body: { configuration: { dryRun: false } } })).toBe(false)
    expect(dryRunOf({ dryRun: true })).toBe(true)
    expect(dryRunOf({ configuration: { dryRun: false } })).toBe(false)
  })

  test("a request Google would not accept is refused with a reason", () => {
    const jobPath = "/bigquery/v2/projects/invented-project/jobs"
    expect(contractViolation({ method: "POST", path: jobPath, body: { jobReference: { projectId: "invented-project" }, configuration: { query: { query: "SELECT 1", madeUpField: true } } } })).toContain("madeUpField")
    expect(contractViolation({ method: "POST", path: jobPath, body: { jobReference: { projectId: "invented-project", location: "" }, configuration: { query: { query: "SELECT 1" } } } })).toContain("empty JobReference.location")
    expect(contractViolation({ method: "POST", path: `${jobPath}/${"oc_x"}/cancel`, body: {} })).toContain("must be empty")
    expect(contractViolation({ method: "GET", path: `${jobPath}/${"oc_x"}`, query: { location: "" } })).toContain("empty location")
    expect(contractViolation({ method: "GET", path: jobPath, query: { stateFilter: "done" } })).toContain("stateFilter")
    expect(contractViolation({ method: "POST", path: "/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_table/testIamPermissions" })).toBeUndefined()
    expect(contractViolation({ method: "POST", path: "/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_table:testIamPermissions", body: { permissions: [] } })).toBeUndefined()
    expect(contractViolation({ method: "GET", path: jobPath, query: { projection: "FULL", stateFilter: "DONE" } })).toBeUndefined()
    // A parameterValue is Google's QueryParameterValue, `{ value }`, not a bare scalar (src/ports.ts, PR #5).
    const parameters = (parameterValue: unknown) => ({ method: "POST", path: jobPath, body: { configuration: { query: { query: "SELECT @id", queryParameters: [{ name: "id", parameterType: { type: "INT64" }, parameterValue }] } } } })
    expect(contractViolation(parameters("1"))).toContain("QueryParameterValue")
    expect(contractViolation(parameters({ value: "1" }))).toBeUndefined()
    expect(contractViolation(parameters({ arrayValues: [{ value: "1" }] }))).toBeUndefined()
  })
})
