# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The repository scaffold, in the family's layout from opencode-github and opencode-specter: the `jelly` declaration,
  the build to two self-contained bundles, the shared kit (r4.1) and `scripts/check.mjs` as the one check gate.
- The `access` option (`all`, the default; `ask-changes`; `read-only`) and its default rules.
- `/bigquery-status`, the `/bigquery` dialog and the status RPC, which make no Google call.
- The `opencode-bigquery` and `opencode-bigquery-sql` skills, as outlines.
- An original icon, the family's tile with a database mark; not Google's logo.
- The plugin's contract: the action table (19 tools, 12 of them reads, and two method-only reads, `saved_list` and
  `probe`), every tool's schemas and the result envelope, the error table, every BigQuery statement type mapped to a
  plan category, the sign-in levels and the write binding, the plan store, the ports and their fakes, and the options.
- The nineteen tools and the tools RPC's fourteen reads, registered and answering `NOT_BUILT` until each is built.
- The default rules from the action table: reads allowed at every access; save, cancel and the five commits at the
  access's change effect; `bigquery.uncapped_read` asked at `all` and `ask-changes`, denied at `read-only`. In Jelly,
  Allowed runs it without asking, bounded by the 120-second job limit and an opt-in budget; the card, README, skill and
  docs say so.
- The full `jelly` declaration (21 entries, the `bigquery.uncapped_read` ask, the Google sign-in with the disclosure)
  and the `sources` block (`bigquery.jobs`, `bigquery.saved`), checked by the source contract v0.2.0.
- `google-auth-library` 11.3.4, bundled for the opt-in ADC mode.
- `docs/ownership.md`: which package owns each file.
