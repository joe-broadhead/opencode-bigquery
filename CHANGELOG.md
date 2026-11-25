# Changelog

All notable changes to this plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the plugin follows the plugin standard: `0.x` releases may break between minors.

## [0.0.0] - prepared

The first release on plugin-contract v0.

### Added

- One `register` call wires every method as an agent tool, a Code Mode entry and an RPC method, under the plugin name
  `bigquery`.
- Accounts through the contract's `accounts` module: one integration per alias, `bigquery` for `default` and
  `bigquery-<alias>` for any other, with a Read or Read and write level.
- Plan-then-commit changes: `plan_write`, `plan_export`, `plan_share`, `plan_delete`, `plan_admin`, each with its own
  committing method that takes only `{ planId }`; and `plan_query` / `run_query` for a read the byte cap cannot bound.
- The `bigquery.jobs` events source and the `bigquery.saved` snapshot source, with `probe` and `saved_list`.
- `changed` on the bus after a job starts or is cancelled.
- Options for the byte cap and ceiling, a daily or per-session budget, the inline budget, the dataset fence, the saved
  queries, scripts and admin statements.
- Documentation, two skills, and a conformance fixture recorded from two synthetic accounts.

### Changed from the source-contract v0.3 plugin

- The app-specific declarations, the tools RPC and the copied kit are gone; the manifest's `capabilities` is the one
  declaration and `plugin-kit` runs the checks.
- A commit runs as the account its plan recorded, and takes no `account` in its input.
- The uncapped read is its own plan/commit pair (`plan_query`, `run_query`); `query` is a pure capped read.
- `bigquery.read`, a permission-only action, is folded into the sources' and methods' `operations`.
- ADC mode and the slash commands are removed; a headless machine uses `token` mode.
