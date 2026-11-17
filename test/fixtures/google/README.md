# BigQuery fixtures

Invented answers in Google's shapes, written from the REST reference v2 on 17 Nov 2026, one file per call:

| File | Google's page |
| --- | --- |
| `dry-run-select.json` | `jobs.insert` with `dryRun: true`; `statistics.query` of the Job resource |
| `job-running.json`, `job-done.json` | the Job resource, `jobReference`, `configuration`, `statistics`, `status` |
| `job-bytes-billed.json` | a Job whose `status.errorResult.reason` is `bytesBilledLimitExceeded` |
| `job-timeout.json` | a Job whose `status.errorResult.reason` is `timeout` |
| `results-page-1.json`, `results-page-2.json` | `jobs.getQueryResults`, with `schema`, `rows` in `f`/`v` form and a `pageToken` |
| `projects-list.json`, `datasets-list.json`, `tables-list.json` | `projects.list`, `datasets.list`, `tables.list` |
| `table-get.json`, `table-data.json` | the Table resource, and `tabledata.list` |
| `routines-list.json`, `routine-get.json` | the Routine resource |
| `row-access-policies.json` | `rowAccessPolicies.list` |
| `test-iam-permissions.json` | `tables.testIamPermissions` |
| `error-*.json` | Google's standard error body with an `ErrorProto` |

Every identifier is invented (`invented-project`, `invented_dataset`, `example.invalid`), and nothing here is real
data. `scripts/capture-fixtures/index.mjs` records the same calls against a scratch project at the live check, sanitises
them the same way, and writes them over these files; a test (`test/unit/process/fixtures.test.ts`) fails on an id that
does not look invented.

Reference pages:

- `https://cloud.google.com/bigquery/docs/reference/rest/v2/Job`
- `https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert`
- `https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults`
- `https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/list`
- `https://cloud.google.com/bigquery/docs/reference/rest/v2/tables`
- `https://cloud.google.com/bigquery/docs/reference/rest/v2/routines`
- `https://cloud.google.com/bigquery/docs/reference/rest/v2/rowAccessPolicies/list`
