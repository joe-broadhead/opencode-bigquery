# Capabilities

The manifest's own declaration, then what each capability does. `plugin-kit docs` writes the generated table from
`capabilities` in `package.json`; edit the manifest, never the table.

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `status` | read | none | — |
| `probe` | read | optional | — |
| `list` | read | optional | `bigquery.projects.list`, `bigquery.datasets.list`, `bigquery.tables.list`, `bigquery.routines.list`, `bigquery.tables.get` |
| `table` | read | optional | `bigquery.tables.get`, `bigquery.tabledata.list`, `bigquery.rowAccessPolicies.list`, `bigquery.jobs.query` |
| `search` | read | optional | `bigquery.jobs.query`, `bigquery.datasets.list`, `bigquery.tables.list` |
| `estimate` | read | optional | `bigquery.jobs.queryEstimate` |
| `query` | read | optional | `bigquery.jobs.query`, `bigquery.jobs.insert`, `bigquery.jobs.getQueryResults`, `bigquery.jobs.get`, `bigquery.jobs.cancel` |
| `job` | read | optional | `bigquery.jobs.get`, `bigquery.jobs.getQueryResults`, `bigquery.tables.get` |
| `jobs` | read | optional | `bigquery.jobs.list` |
| `profile` | read | optional | `bigquery.jobs.query`, `bigquery.jobs.insert`, `bigquery.jobs.getQueryResults` |
| `events_list` | read | optional | `bigquery.jobs.list` |
| `saved_read` | read | optional | `bigquery.jobs.query`, `bigquery.jobs.getQueryResults`, `bigquery.routines.get`, `bigquery.rowAccessPolicies.list`, `bigquery.tabledata.list`, `bigquery.tables.get` |
| `saved_list` | read | optional | `bigquery.jobs.queryEstimate`, `bigquery.jobs.query` |
| `plan_write` | read | optional | `bigquery.jobs.insert` |
| `plan_export` | read | optional | `bigquery.jobs.insert` |
| `plan_share` | read | optional | `bigquery.jobs.insert` |
| `plan_delete` | read | optional | `bigquery.jobs.insert` |
| `plan_admin` | read | optional | `bigquery.jobs.insert` |
| `plan_query` | read | optional | `bigquery.jobs.insert` |
| `run_query` | read | none | `bigquery.jobs.insert`, `bigquery.jobs.getQueryResults`, `bigquery.jobs.get`, `bigquery.jobs.cancel` |
| `write` | write | none | `bigquery.jobs.insert` |
| `export` | export | none | `bigquery.jobs.insert` |
| `share` | share | none | `bigquery.jobs.insert` |
| `delete` | delete | none | `bigquery.jobs.insert` |
| `admin` | admin | none | `bigquery.jobs.insert` |
| `cancel` | write | optional | `bigquery.jobs.cancel`, `bigquery.jobs.get` |
| `save` | export | optional | `bigquery.jobs.getQueryResults`, `bigquery.jobs.get` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|
| `bigquery.jobs` | events | `x-bigquery/job` | `events_list` | free |
| `bigquery.saved` | snapshot | `table` | `saved_read` | billed |

### Actions

None.

### Bus events

`rpc.bigquery.changed`
<!-- /generated:capabilities -->

## What the methods do

### Reads

- `status` — every alias's state, the host range, the agents the access rules miss, and one redacted next step.
  It takes no account (`accounts: none`): it answers for every alias at once, so the inventory's `optional` is
  reconciled as `none`.
- `probe` — the signed-in account behind a source, owner included; reads no BigQuery content.
- `list` — projects; a project's datasets; a dataset's tables or routines. Free.
- `table` — a table's schema, partitioning, clustering, size and view SQL; an optional sample (free) or its partitions
  (a billed, capped query).
- `search` — tables and columns by name or description, through `INFORMATION_SCHEMA`. Billed at least 10 MB per view.
- `estimate` — a free dry run: the statement type, referenced objects, bytes, cost, and whether the byte cap bounds it.
- `query` — SELECT or ASSERT under the byte cap, after a dry run. Billed.
- `job` — one job's state, bytes and errors, and a page of its results. Free.
- `jobs` — this account's recent jobs. Free.
- `profile` — one aggregate query (nulls, distinct, min, max, quartiles, top values) over a table or a SELECT. Billed and
  capped.
- `events_list` — the `bigquery.jobs` source: this account's finished jobs, oldest first, from a cursor.
- `saved_read` — the `bigquery.saved` source: one saved query's result as the `table` shape.
- `saved_list` — the saved queries a person may confirm, each with its SQL and a free estimate.
- `plan_write`, `plan_export`, `plan_share`, `plan_delete`, `plan_admin` — the five change planners: a free dry run, a
  preview and a plan the matching commit spends once.
- `plan_query` — a plan for a read the byte cap cannot bound, spent by `run_query`.
- `run_query` — run an uncapped-read plan, at the plan's cap and the short uncapped time limit.

### Changes

- `write` commits a `plan_write`; `export` a `plan_export`; `share` a `plan_share`; `delete` a `plan_delete`; `admin` a
  `plan_admin`. Each takes only `{ planId }`, runs as the account that planned it, re-checks the statement with a fresh
  dry run and refuses `PLAN_CHANGED` if anything the preview showed moved.
- `cancel` stops a running job this plugin started. A Read account cancels only the plugin's read jobs.
- `save` writes a finished job's rows to a local CSV, JSONL or Parquet file; it never calls a billed API.

The methods table's class decides access: under `ask-changes` every class but `read` asks first, and under `read-only`
they are off. `run_query` carries an `effect` of `ask`, so a read the cap cannot bound asks under `all`, `ask-changes`
and `read-only` even though it is classed as a read; a person's explicit rule can still allow it.

## Sources

- `bigquery.jobs` is an events source (`kind: events`, `reads: x-bigquery/job`): one event per job that finished in the
  read's window, with the statement type and what it billed. It is free and private, and signals `bus`.
- `bigquery.saved` is a snapshot source (`kind: snapshot`, `output: table`): one saved query from the plugin's
  `savedQueries` option, run through the same read path as `query`, capped and billed. Its scope's `queries` is what a
  person confirms, and `saved_list` is the bind-time read that lists them.

There are no actions: an app offers a person BigQuery writes through the plan/commit methods, not through an app action
surface.

## Bus events

`rpc.bigquery.changed` carries `{ capability, account, reason }` after this plugin starts or cancels a job; an app that
receives one re-reads `bigquery.jobs` through RPC. The event carries no content.
