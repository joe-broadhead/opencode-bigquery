# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A source install, or any install that is not a tagged release, answers `NOT_RELEASED` and sends nothing to Google.
  The handlers stay; a tagged install runs them. There is no release tag yet.

- The repository scaffold, in the family's layout from opencode-github and opencode-specter: the `jelly` declaration,
  the build to two self-contained bundles, the shared kit (r4.1) and `scripts/check.mjs` as the one check gate.
- The `access` option (`all`, the default; `ask-changes`; `read-only`) and its default rules.
- `/bigquery-status`, the `/bigquery` dialog and the status RPC, which make no Google call.
- The `opencode-bigquery` and `opencode-bigquery-sql` skills.
- An original icon, the family's tile with a database mark; not Google's logo.
- The plugin's contract: the action table (19 tools, 12 of them reads, and two method-only reads, `saved_list` and
  `probe`), every tool's schemas and the result envelope, the error table, every BigQuery statement type mapped to a
  plan category, the sign-in levels and the write binding, the plan store, the ports and their fakes, and the options.
- The nineteen tools and the tools RPC's fourteen reads, registered; a tool a given build does not carry answers
  `NOT_BUILT`.
- The default rules from the action table: reads allowed at every access; save, cancel and the five commits at the
  access's change effect; `bigquery.uncapped_read` asked at `all` and `ask-changes`, denied at `read-only`. In Jelly,
  Allowed runs it without asking, bounded by the 120-second job limit and an opt-in budget; the card, README, skill and
  docs say so.
- The full `jelly` declaration (21 entries, the `bigquery.uncapped_read` ask, the Google sign-in with the disclosure)
  and the `sources` block (`bigquery.jobs`, `bigquery.saved`), checked by the source contract v0.3.0.
- `google-auth-library` 11.3.4, bundled for the opt-in ADC mode.
- `docs/ownership.md`: which package owns each file.
- The Google sign-in (package A): the two-level form with the disclosure, PKCE and the relay, DPoP with a P-256 key per
  sign-in, the write binding from Google's own scope list, `prompt=consent` on every sign-in, session-control mapping,
  ADC and `token` accounts (read-only), `/bigquery-doctor` with the IAM check, and `/bigquery-signout`. Never `/revoke`.
- The runtime (package B): BigQuery's REST port over `fetch`, dry runs and runs through `jobs.insert` with a client job
  id, the 409 join, retries with jittered backoff and the 8-request limit, value conversion with exact TIMESTAMP and
  INT64, paging under a 10 MiB answer cap, Stop that cancels the job, the fake Google server and the fixture capture
  script.
- The reads and guards (package C): the GoogleSQL lexer, expansion of views and routines (bounded), the side-effect,
  dataset-fence, cap-enforceability, cost and policy-tag guards, the spend ledger and budgets, hints, and the eight read
  tools with a sample, partitions, search, estimate, query, job, jobs and profile.
- `bigquery_save` (package E): a finished query's results to a CSV, JSONL or Parquet file, with sha256, the save limits
  and the charts metadata.
- The `bigquery.jobs` source: your finished jobs, each delivered once, read on Google's clock, with jobs still running
  tracked until they finish.
- The `bigquery.saved` source: saved queries through the read path as a table, with `saved_list` and `probe`, and the
  source contract's conformance run with a complete `reports/conformance-report.json`.
- `bigquery_status` (package F): each account's level from the two §3.1 checks (with the reason when one fails), a
  Read account's disclosure, the byte caps, today's and this session's bytes and dollars from the ledger, the free
  checks `include` adds (`jobs`, `iam`, `spend`), and the warnings a person needs. The status RPC, `/bigquery-status`
  and the TUI add the accounts, dataset fences, caps, budget and today's billed bytes as rows.
- `docs/costs.md` and `docs/sql.md`, and a rewritten README with a **Known limits** section: the cap's real guarantee,
  policy-tagged results, uncapped reads under Jelly's Allowed, the expansion caps, the fail-closed cases, Stop's worst
  case, and the live checks still to run.
- A check-gate guard that fails the TUI bundle if it carries a minified host import
  (`test/unit/status/tui-bundle.test.ts`), against OpenTUI's own rewrite patterns, and one that runs every SQL example
  the docs and the SQL skill show through the read path, so an example the plugin refuses fails the build.

### Changed

- The `sources` block leaves out the keys source-contract v0.1.x consumers (Jelly and Memory today) refuse: the
  `bigquery.saved` price's `conditions` and `min`, and the empty `permission.identity` of both sources. The price stays
  $6.25 per TiB billed; its conditions (on-demand pricing; at most 1 GiB billed per read unless you raise it; cached
  reads are free) are in the README's Cost section, `docs/jelly.md` and the jelly cost line. They return once those
  consumers re-vendor v0.2.0.

### Fixed

- The expansion of views and routines is bounded per read: at most 32 views and routines, 3 levels deep, 256 metadata
  lookups, and a dry-run list of 50 or more objects is treated as possibly cut. Past any of them the read goes to a
  plan, and the dry run's own lists are fenced before anything is expanded.

