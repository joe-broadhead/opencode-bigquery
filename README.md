# BigQuery plugin for OpenCode

BigQuery over its REST API, as OpenCode tools: list projects, datasets, tables and routines; inspect a table; find a
column; estimate a query before it runs; run reads under a byte cap; profile a table; save a result to a local file;
and plan then commit changes. Every alias signs in on its own, so a work and a personal Google account can be used side
by side.

The plugin is built on [plugin-contract](https://github.com/we-the-rebel-alliance/plugin-contract) v0: one manifest,
accounts and access through the contract's modules, and one `register` call for every method.

Queries bill the person's Google Cloud project. Every job carries a byte cap, and a read the cap cannot bound needs a
plan the person previews.

## Install

No release exists yet: the first one, `v0.0.0`, is cut after this branch merges. Install it then with

```sh
opencode plugin add github:we-the-rebel-alliance/bigquery-plugin#v0.0.0
```

The plugin needs OpenCode `>=2.4.1 <2.5.0` and has no runtime dependencies: `dist/index.js` is one self-contained bundle.

## Sign in

1. Create a Google Cloud project with the BigQuery API enabled, or use one you already have.
2. Run `/connect` in OpenCode and choose **BigQuery**. Sign in with Google and approve every scope shown; the BigQuery
   scope is the one the plugin needs.
3. Set the account's billing project in the plugin's options, unless every call passes `project`:

```json
{
  "plugins": [
    {
      "package": "github:we-the-rebel-alliance/bigquery-plugin#v0.0.0",
      "options": { "accounts": { "work": { "billingProject": "my-project-1234" } } }
    }
  ]
}
```

### Several accounts

Each alias in `options.accounts` is its own integration, `<name>` for `default` and `bigquery-<alias>` for any other:

```json
{ "accounts": { "work": { "billingProject": "work-project" }, "personal": { "billingProject": "home-project" } } }
```

Run `/connect` once per alias. Every method that reads or changes BigQuery directly takes `account`; with one account
it may be left out, with several a missing one is `ACCOUNT_REQUIRED` and its next step lists the aliases. A commit
takes only `{ planId }` and runs as the account that made its plan. A `token` account reads
a short-lived access token from an environment variable instead (`"mode": "token", "tokenEnv": "GOOGLE_ACCESS_TOKEN"`).

The sign-in's level is Read or Read and write. Read runs every read and refuses every commit before Google is called;
only the person can sign in again choosing Read and write. For Google itself to refuse changes, ask an administrator to
grant BigQuery Job User and Data Viewer, and nothing that can write.

## Options

The common options; [Configuration](docs/configuration.md) has every option and its default.

```json
{
  "options": {
    "access": "ask-changes",
    "accounts": { "work": { "billingProject": "work-project-1234", "location": "EU" } },
    "maxBytesBilled": "10GiB",
    "maxBytesCeiling": "100GiB",
    "budget": { "daily": "200GiB", "action": "refuse" },
    "savedQueries": { "revenue_today": { "sql": "SELECT order_date, SUM(total) AS revenue FROM `work-project-1234.analytics.orders` GROUP BY order_date", "maxBytes": "1GiB" } }
  }
}
```

- `access`: `all`, `ask-changes` or `read-only`.
- `accounts`: one profile per alias, with its `billingProject`, `location`, `level`, `datasets` fence and `scopes`.
- `maxBytesBilled` / `maxBytesCeiling`: the default byte cap on a job and the most a call may raise it to.
- `budget`: a daily or per-session spend limit, counted from what Google actually billed (`refuse` or `warn`).
- `savedQueries`: the saved queries the `bigquery.saved` source may run.
- `allowUntestedHost`: start on an OpenCode release outside the tested range; a supported host never needs it.

## Access

The plugin's `access` option is the person's ceiling: `all` (the default) runs every method, `ask-changes` asks before
each change, `read-only` runs reads and turns changes off. A method's own effect can only narrow that. The generated
rules go into every agent; an agent that lacks them is named in `status`.

Writes are plan, then commit: a planner dry-runs the statement and answers a preview and a `planId`; the commit method
takes only `{ planId }`, re-checks the statement and runs it once, as the account that planned it.

## Troubleshooting

- **The tools are missing.** The plugin refused the host (`HOST_UNTESTED`) or failed to load: run `npx plugin-kit check`
  in a checkout and read `status`; on a supported OpenCode `>=2.4.1 <2.5.0` it starts.
- **`NEEDS_SIGN_IN`.** Run `/connect` and choose the account the next step names; a `token` account needs its environment
  variable set.
- **`ACCOUNT_REQUIRED` / `ACCOUNT_UNKNOWN`.** Pass `account` with one of the aliases the next step lists.
- **`BUDGET_EXCEEDED`.** Narrow the query, or raise `maxBytes` up to `maxBytesCeiling`, or the budget.
- **A read is refused and names `plan_query`.** The byte cap cannot bound it: plan it with `plan_query`, show the
  preview, then commit with `run_query`.
- **`PLAN_INVALID` / `PLAN_USED`.** A plan commits once and expires after 15 minutes: plan again.
- **`PERMISSION_DENIED`.** The account, the dataset fence or the person's rules refuse it. Do not widen it yourself.

## Documentation

- [Capabilities](docs/capabilities.md): every method, source and bus event, with what it does.
- [Configuration](docs/configuration.md): every option and its default.
- [Accounts](docs/accounts.md): the sign-in mechanism, profiles and per-alias calls.
- [Automations](docs/automations.md): a timer that reads new jobs through `events_list`.
- [Architecture](docs/architecture.md): layers, the provider client and what is cached.
- [Security](docs/security.md): what leaves the machine, the scopes, redaction and the plan flow.
- [AGENTS.md](AGENTS.md): the guide for an agent working in this repository.
- [plugin-contract](https://github.com/we-the-rebel-alliance/plugin-contract): the contract and the plugin standard.

## Capabilities

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

## Errors

Every failure reads `CODE: What happened. Next step: What to do.` A status and a probe answer never carry a credential;
a reason is redacted and cut to one line.

<!-- generated:errors -->
| Code | Meaning |
|---|---|
| `NEEDS_SIGN_IN` | the account is not signed in |
| `SCOPE_MISSING` | the call needs a scope the person has not confirmed |
| `ACCOUNT_REQUIRED` | the plugin serves several accounts and the call names none |
| `ACCOUNT_UNKNOWN` | the call names an alias the plugin does not serve |
| `ACCOUNT_MISMATCH` | the item belongs to another account |
| `CURSOR_INVALID` | the cursor is malformed, or belongs to another source, account or scope |
| `CURSOR_EXPIRED` | the provider no longer keeps the history the cursor names |
| `RATE_LIMITED` | the provider asked the plugin to slow down |
| `BUDGET_EXCEEDED` | the read would cost more than the person allows |
| `SOURCE_DISABLED` | the person turned this source or action off |
| `TOO_LARGE` | the answer is larger than the source's maxBytes |
| `INPUT_INVALID` | the input does not match the method's schema |
| `SOURCE_UNKNOWN` | the plugin declares no such source |
| `SCHEMA_VIOLATION` | an answer does not keep the contract's shape |
| `PERMISSION_DENIED` | the person's grant does not cover the call |
| `PLAN_INVALID` | the plan is missing, or belongs to another method |
| `PLAN_USED` | the plan was already used by an earlier commit |
| `GRANT_INVALID` | the action grant did not verify, or was already spent |
| `HOST_UNTESTED` | OpenCode is outside the plugin's tested range |
| `OPTIONS_INVALID` | the plugin's options do not match their schema |
| `UNAVAILABLE` | the provider could not be reached |
<!-- /generated:errors -->

## Licence

MIT. See [LICENSE](LICENSE); [NOTICE](NOTICE) lists the code bundled into `dist/`.
