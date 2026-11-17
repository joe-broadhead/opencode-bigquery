# BigQuery fixtures

Invented answers in Google's documented shapes, one file per call. Each is checked against its page by
`test/unit/process/fixtures.test.ts`, which holds the field lists below; a field the page does not have fails the test.

| File | Google's page | Documented fields used |
| --- | --- | --- |
| `projects-list.json` | [projects.list](https://cloud.google.com/bigquery/docs/reference/rest/v2/projects/list) | `kind`, `etag`, `projects[]` (`kind`, `id`, `projectReference`, `friendlyName`), `totalItems` |
| `datasets-list.json` | [datasets.list](https://cloud.google.com/bigquery/docs/reference/rest/v2/datasets/list) | `kind`, `etag`, `datasets[]` (`kind`, `id`, `datasetReference`, `friendlyName`, `location`), `nextPageToken`, `totalItems` |
| `tables-list.json` | [tables.list](https://cloud.google.com/bigquery/docs/reference/rest/v2/tables/list) | `kind`, `etag`, `tables[]` (`kind`, `id`, `tableReference`, `friendlyName`, `type`, `timePartitioning`, `clustering`, `view`, `creationTime`, `expirationTime`, `requirePartitionFilter`), `nextPageToken`, `totalItems` |
| `table-get.json` | [Table](https://cloud.google.com/bigquery/docs/reference/rest/v2/tables) | the Table resource: `kind`, `etag`, `id`, `selfLink`, `tableReference`, `friendlyName`, `description`, `labels`, `schema`, `timePartitioning`, `clustering`, `requirePartitionFilter`, `numBytes`, `numLongTermBytes`, `numRows`, `creationTime`, `expirationTime`, `lastModifiedTime`, `type`, `location`, `streamingBuffer` |
| `table-data.json` | [tabledata.list](https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/list) | `kind`, `etag`, `totalRows`, `pageToken`, `rows[]` (`f`/`v`) |
| `routines-list.json`, `routine-get.json` | [Routine](https://cloud.google.com/bigquery/docs/reference/rest/v2/routines), [routines.list](https://cloud.google.com/bigquery/docs/reference/rest/v2/routines/list) | `kind`, `etag`, `routineReference`, `routineType`, `creationTime`, `lastModifiedTime`, `language`, `definitionBody`, `arguments`, `remoteFunctionOptions` (the list answers the last four because the port sends a `readMask`) |
| `row-access-policies.json` | [RowAccessPolicy](https://cloud.google.com/bigquery/docs/reference/rest/v2/rowAccessPolicies), [rowAccessPolicies.list](https://cloud.google.com/bigquery/docs/reference/rest/v2/rowAccessPolicies/list) | `etag`, `rowAccessPolicyReference` (`projectId`, `datasetId`, `tableId`, `policyId`), `filterPredicate`, `creationTime`, `lastModifiedTime` — the id is **nested**, there is no top-level `policyId` |
| `test-iam-permissions.json` | [tables.testIamPermissions](https://cloud.google.com/bigquery/docs/reference/rest/v2/tables/testIamPermissions) | `POST …/tables/{t}:testIamPermissions`, body `permissions[]`, answer `permissions[]` |
| `dry-run-select.json`, `job-running.json`, `job-done.json`, `job-bytes-billed.json`, `job-timeout.json`, `job-bytes-billed-get.json` | [Job](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job), [jobs.insert](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert), [jobs.get](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/get) | `kind`, `etag`, `id`, `jobReference`, `configuration` (`jobType`, `query`, `dryRun`, `jobTimeoutMs`, `labels`), `statistics` (`creationTime`, `startTime`, `endTime`, `totalBytesProcessed`, `totalSlotMs`, `query`), `status` (`state`, `errorResult`) |
| `results-page-1.json`, `results-page-2.json`, `results-warning.json` | [jobs.getQueryResults](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults) | `kind`, `etag`, `schema`, `jobReference`, `totalRows`, `pageToken`, `rows[]`, `totalBytesProcessed`, `jobComplete`, `errors[]`, `cacheHit` |
| `error-*.json` | [jobs.getQueryResults](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults), [ErrorProto](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#errorproto), [error messages](https://cloud.google.com/bigquery/docs/error-messages) | `error` (`code`, `message`, `errors[]` with `reason`/`location`, `status`) |

Values: a TIMESTAMP is the microseconds since the epoch as an int64 string, because the port sends
[`formatOptions.useInt64Timestamp`](https://cloud.google.com/bigquery/docs/reference/rest/v2/DataFormatOptions); a BOOL
is the string `"true"`/`"false"`, as REST sends it. Job-failure reasons are cited on the
[error messages](https://cloud.google.com/bigquery/docs/error-messages) page; `bytesBilledLimitExceeded` and `timeout`
arrive as an HTTP 400 on `jobs.getQueryResults` (`error-bytes-billed-400.json`, `error-timeout-400.json`) as well as on a
DONE job (`job-bytes-billed.json`, `job-timeout.json`). **Unverified until the live check:** whether a job stopped by
`jobTimeoutMs` reports the reason `timeout` (L4/L15), and whether a dry run's answer carries `jobReference.location`
(L8) — both are marked in the code.

Every identifier is invented (`invented-project`, `invented_dataset`, `example.invalid`), every cell in
`results-page-*.json` is an invented value, and the policy tag is an invented taxonomy path. `scripts/capture-fixtures/`
records the same calls at the live check, replaces every cell and tag, and writes them over these files.

The fake (`test/fake/bigquery.ts`) also rejects a request Google would not accept: an unknown query parameter, an empty
`location`, a body field that is not on the resource, a JSON body where the page says empty, or an enum in the wrong
case. A wrong URL or shape fails the test instead of being answered.
