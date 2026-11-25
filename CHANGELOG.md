# Changelog

## 0.0.0 (2026-11-25)

BigQuery over its REST API as OpenCode methods, on plugin-contract v0.

- **Install and sign-in:** one integration per account alias (`bigquery` for `default`, `bigquery-<alias>` otherwise),
  with Google OAuth. Read and Read and write levels; a `token` profile reads a short-lived access token from an
  environment variable. The plugin holds no runtime dependency.
- **27 methods:** 20 read, 2 write, 2 export, 1 share, 1 delete, 1 admin, reachable as agent tools, in Code Mode and
  over RPC through one `register` call.
- **Reads:** projects, datasets, tables and routines; a table's schema, a sample and its partitions; `INFORMATION_SCHEMA`
  search; free dry runs; SELECT/ASSERT under a byte cap on every job; one job and its rows; recent jobs; a profile
  aggregate; a saved query as a table.
- **Plan then commit:** `plan_write`, `plan_export`, `plan_share`, `plan_delete` and `plan_admin`, each with exactly one
  committing method that takes only `{ planId }`, re-runs the dry run and refuses a changed plan; `plan_query` and
  `run_query` for a read the byte cap cannot bound.
- **Sources:** `bigquery.jobs` (events, a cursor bound to the account and scope) and `bigquery.saved` (a `table`
  snapshot), with `probe` and `saved_list`.
- **Bus:** `changed` after a job starts or is cancelled.
- **Safety:** the account's dataset fence, a policy-tag rule, a daily or per-session budget counted from what Google
  billed, and the inline row budget.
- **Docs and tests:** generated capabilities and configuration, two skills, and 39 unit tests over the real provider,
  read guards and handlers; a conformance fixture recorded from two synthetic accounts.
