# Architecture

How the plugin is built, for contributors. It follows opencode-gws: one namespace, the plugin's own tools over the
vendor's REST API, plan then commit for every change. The design is the source of every rule here; the packages that
build each part, and the files each owns, are in [File ownership](ownership.md).

## The contract

| Module | What it fixes |
| --- | --- |
| `src/domain/actions.ts` | The one action table: 19 tools and 2 method-only reads, each with its action `bigquery.<name>`, read-only flag, class, operation and owner; the run-time ask `bigquery.uncapped_read`; which tool commits which plan category. The default rules, the jelly declaration, the registry and the tools RPC all come from it. |
| `src/domain/contract.ts` | Every tool's input and output schema, and the result envelope: `state`, `error`, `message`, `next`, `reason`, `googleError` (Google's text, untrusted), `warnings`. |
| `src/domain/errors.ts` | The one error table, with each code's state and owning package, the warnings, and the source contract's code for each. |
| `src/domain/statements.ts` | Every `statementType` in Google's enum (`test/fixtures/statement-types.json`, read by `scripts/statement-types.mjs`) mapped to a kind; `raise` never lowers a decision. |
| `src/domain/levels.ts` | The sign-in record, the scopes of each level, the authorization parameters (`prompt=consent`, never `include_granted_scopes`), and `decideLevel`: `write` only on both checks of design §3.1. The revocation endpoints the plugin never calls. The disclosure. |
| `src/domain/plans.ts` | The single-use plan store, bound to session, agent, account and category, and the plan's allowlisted prompt metadata. |
| `src/domain/lexer-api.ts` | The lexer's token types and findings; package C builds the lexer to it. |
| `src/domain/google.ts`, `accounts.ts`, `identifiers.ts` | Google's addresses and resource types; account resolution and assert resources; validated identifiers for messages. |
| `src/domain/probe.ts` | The row-policy probe's text: plain `SELECT *` with no tagged column, never `SELECT * EXCEPT ()`, and a partition filter that keeps every partition. |
| `src/ports.ts` | The ports: BigQuery (dry run and run through `jobs.insert`), auth (`token`, `level`), the spend ledger, the plan store and the clock. `test/fake/ports.ts` fakes each. |
| `src/options.ts` | Every option of design §12, strict. |

## The plugin

| Module | What it does |
| --- | --- |
| `src/index.ts`, `src/plugin.ts` | The server part: `Plugin.define` with the id `google-cloud.bigquery`, set up in opencode-github's order. |
| `src/registry.ts` | One spec per action-table entry, with its schemas and its package's handler (`src/handlers/*`), or `NOT_BUILT`. It resolves the account, asserts a read's own action before its handler, hands the handler ports that refuse any request before that assert, refuses an undeclared assert, refuses an uncapped-read plan from a script, and turns a refusal into the envelope. |
| `src/wiring.ts`, `src/unbuilt.ts` | The ports the plugin runs with; each package replaces its unbuilt port. |
| `src/permissions.ts` | The default rules from the action table, inserted after each agent's base allow. |
| `src/tool-spec.ts`, `src/tools.ts` | A spec as the model's tool and as a tools RPC method; the namespace and the tools' registration. |
| `src/host/script-methods.ts` | The tools RPC's plugin value and its methods (the reads), for the source contract's `tools-rpc`. |
| `src/rpc.ts`, `src/status.ts`, `src/tui/index.tsx` | The status contract, `/bigquery-status`, the status RPC and the `/bigquery` dialog. |
| `src/constants.ts`, `src/skills.ts`, `src/redact.ts`, `src/host-version.ts`, `src/version.ts` | Ids and the host range; skills, redaction, the host check and the version. |

## Setup order

Options, the host check, then each registration, kept for cleanup in reverse: the default rules; the namespace and the
nineteen tools; status; the tools RPC (the fourteen reads); the skills. Every transform is synchronous and never
throws: a failure is kept, and status shows it with its next step.

## The bundle

`dist/index.js` carries zod, the source contract's tools RPC and `google-auth-library`, which only the opt-in `adc`
mode loads, on first use (`src/auth/adc-library.ts`). The package keeps no runtime dependency. The library is
CommonJS, so the bundle opens with a `require` from `node:module`'s `createRequire`; `node-fetch` is replaced by the
runtime's own `fetch` and `debug`'s optional `supports-color` by a stub (`scripts/shims`).
