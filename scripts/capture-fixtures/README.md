# Fixture capture

`index.mjs` records the captures of design §14.2 from a scratch Google Cloud project and writes them to
`test/fixtures/google/`, one file per call, in the shape `test/fake/bigquery.ts` replays. It is the only script here
that talks to Google, and no test imports it: it refuses to start under a test runner, and needs `BQ_CAPTURE=1`.

```sh
BQ_CAPTURE=1 \
BQ_CAPTURE_PROJECT=my-scratch-project \
BQ_CAPTURE_TOKEN="$(gcloud auth print-access-token)" \
  node scripts/capture-fixtures/index.mjs --location EU
```

The calls are: `projects.list`, `datasets.list`, `tables.list`, `tables.get`, `tabledata.list`, `routines.list`,
`rowAccessPolicies.list`, `tables.testIamPermissions`; a `jobs.insert` dry run for each statement type, a script, a
`CREATE TEMP TABLE` dry-run failure, a row-secured table, an external table, a view, a Python UDF and a remote
function; a `jobs.query` dry run; a real `SELECT 1` run and the same client job id again (the 409 `duplicate`); the
same run with `maximumBytesBilled: "1"` (the `bytesBilledLimitExceeded` job); and one `jobs.getQueryResults` page.

Flags name the resources the cases need: `--tagged-table`, `--rls-table`, `--external-table`, `--view`,
`--python-routine`, `--remote-routine`. `--dry-run` lists the calls without making them, and `--force` replaces files
that exist.

Every project id, address and token in an answer is replaced (`invented-project`, `ada@example.invalid`,
`invented-access-token`), and a 12-digit number with zeros, so the recording can be committed. Read each file before
committing it: the sanitiser replaces what it recognises, and a table name a real dataset gave away is not one of them.
Live checks L3, L4, L5 and L8 read these files back through the fake.
