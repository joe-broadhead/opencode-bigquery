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
- **Docs and tests:** generated capabilities and configuration, two skills, and 51 tests over the real provider,
  read guards, handlers and the real 2.4.1 host; a conformance fixture recorded from two synthetic accounts.

### Removed since the last pre-4b release (v0.0.x, 4a `148360a`)

Everything below was removed on purpose; nothing was dropped silently. The parity table in the pull request maps every
old tool and surface to its new one.

- **`/bigquery-status` command** — replaced by the `status` method, which is an agent tool, a Code Mode entry and an RPC
  method at once; a command only duplicated it.
- **`/bigquery-doctor` and `/bigquery-signout` commands** — the doctor and the local sign-out helper were part of the
  pre-4b diagnostic surface. Sign-in state is OpenCode's credential store (and `/connect`); `status` reports each alias.
- **The TUI plugin and its `/bigquery` slash/palette status dialog** — status is the `status` method; the plugin standard
  makes a TUI optional and this package ships none.
- **ADC sign-in mode** — `token` mode covers a headless machine with a short-lived access token, without the ADC library
  and its bundling shims.
- **The single `plan` tool** — replaced by `plan_write`, `plan_export`, `plan_share`, `plan_delete` and `plan_admin`
  (and `plan_query` for the uncapped read): the contract's `register` refuses a plan with more than one committing
  method, and a method has one class.
- **The permission-only `bigquery.read` action** — folded into `events_list`'s, `saved_read`'s and the sources'
  `operations`; contract v0 has no permission-only method.
- **The RPC ids `google-cloud.bigquery` and `google-cloud.bigquery.tools`** — one RPC id, `bigquery` (contract §3).
- **The default integration `bigquery-default`** — renamed `bigquery`; `bigquery-<alias>` is unchanged (contract §5).
