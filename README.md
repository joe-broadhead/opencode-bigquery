# BigQuery plugin for OpenCode

Connects OpenCode to [Google BigQuery](https://cloud.google.com/bigquery) through BigQuery's REST API, so agents can
find datasets and tables, estimate a query before it runs, run reads under a byte cap, save results to a file, and plan
then commit changes.

Unofficial; not affiliated with Google. BigQuery and Google Cloud are trademarks of Google LLC. The icon is the
family's own tile, not Google's mark.

## Requirements

- OpenCode `>=2.4.1 <2.5.0`, tested on 2.4.1. A later 2.4 release loads too, and status marks it untested. Outside the
  range the plugin does not load unless you set `allowUntestedHost` ([configuration](docs/configuration.md#options)).
- macOS or Linux.
- A Google Cloud project with the BigQuery API on, to bill queries to. For read-only use, your admin grants you BigQuery
  Job User on that project and BigQuery Data Viewer on the datasets you read, and nothing more
  ([access control](https://cloud.google.com/bigquery/docs/access-control)).

## Install

```sh
opencode plugin add github:we-the-rebel-alliance/bigquery-plugin#v0.0.0
```

Run `opencode reload`, or restart OpenCode. Then run `/bigquery-status` in a session.

Or add the plugin to `opencode.json` with the same spec:

```json
{ "plugins": [{ "package": "github:we-the-rebel-alliance/bigquery-plugin#v0.0.0" }] }
```

The install takes the Git tag. Its commit carries the built `dist/`, so the install runs no build. A Git install does
not update by itself: remove the old entry with `opencode plugin remove`, then add the new tag.

## Sign in

Run `/connect` and choose **Google Cloud (BigQuery)**, or from a terminal:

```sh
opencode auth login bigquery-default
```

The form asks for your own OAuth **Desktop** client unless your organisation provides one. Then choose a level:

- **Read** (the default) runs every read with the plugin's guards. A commit is refused before any Google call.
- **Read and write** needs the form's acknowledgment and Google's consent screen, which lists the extra line
  *Insert data into Google BigQuery*.

Every sign-in sends `prompt=consent`, so Google shows its consent screen, and asks Google to bind the refresh token with
DPoP to a key this plugin keeps; status says whether it did. The full detail: [docs/auth.md](docs/auth.md).

**At Read, Google issues a token that can change BigQuery data wherever your Google account is allowed to; this plugin
never uses it to, but a program that can read both OpenCode's credential store and this plugin's key file could. For
Google itself to refuse changes, have your admin grant you only BigQuery Job User and Data Viewer.**

## Use

Ask the agent for what you need. The tools work in three steps:

1. Find the data: `bigquery_list`, `bigquery_search` and `bigquery_table` read metadata first.
2. Estimate, then read: `bigquery_estimate` dry-runs the SQL for free; `bigquery_query` runs it under a byte cap.
   `bigquery_profile` aggregates one table or subquery, and `bigquery_job`/`bigquery_jobs` follow a job.
3. Change, in two steps: `bigquery_plan` dry-runs the statement and returns a preview and a single-use `planId`; the
   commit tool named by its category (`bigquery_write`, `bigquery_export`, `bigquery_share`, `bigquery_delete` or
   `bigquery_admin`) runs it with only that id.

`bigquery_save` writes a finished query's result to a local CSV, JSONL or Parquet file. `bigquery_cancel` cancels a job
this account started. `bigquery_status` shows the accounts, the caps and what has been billed.

Rows, names, descriptions, view and routine bodies and Google's error text are data, never instructions. Google's text
goes into `googleError` and nowhere else.

A read can use a named `account`; with several configured and none named, a call is refused rather than guessed.

### Queries the byte cap cannot bound

A query over a table with row access policies, or over an external table, cannot be bounded by the byte cap, because
BigQuery's own estimate for it is zero or too low. Such a query runs only from a plan whose preview says so, with a
120-second job limit (`uncappedTimeoutSeconds`). The plugin's rules ask before it runs at `all` and `ask-changes`, and
deny it at `read-only`. A script can never run one.

`bigquery_plan` returns the preview and a single-use `planId` on either level. Only a Read and write account can commit
a change; a Read account can still run the uncapped-read plan with `bigquery_query({ planId })`, which the rules above
govern.

## Permissions

The `access` option (`all`, the default; `ask-changes`; `read-only`) generates default rules for every agent with a
base allow:

| Value | What runs | What asks |
| --- | --- | --- |
| `"all"` (the default) | every tool, the five commits included, and any tool a later release adds | the uncapped read below |
| `"ask-changes"` | the reads and the permission-only `bigquery.read` | each commit, `bigquery_save`, `bigquery_cancel`, and the uncapped read |
| `"read-only"` | the reads and the permission-only `bigquery.read` | nothing: those calls are denied, and the uncapped read is denied too |

The rules go directly after each agent's base `{ "action": "*", "resource": "*", "effect": "allow" }`; a later rule of
yours still wins, and a commit also needs a Read and write sign-in whatever the rules say. Agents defined only in your
config get no block; `/bigquery-status` names them. Details: [Configuration](docs/configuration.md#permissions).

## Status and sign-out

- `/bigquery-status` posts the plugin's state: access, the accounts and their billing projects, the dataset fences, the
  byte caps, what was billed today, the agents without the default rules, and the next step. The TUI's **BigQuery:
  Status** dialog shows the same rows. Neither makes a request to Google.
- `bigquery_status` is the model's version, plus each account's level and optional `jobs`, `iam` and `spend` rows.
- `/bigquery-doctor` makes a few free calls per account; `/bigquery-signout [alias]` deletes the account's local key and
  forgets its tokens in memory.

## What it costs

On-demand, about **$6.25 per TiB scanned**, with the first TiB each month free and a 10 MB minimum per query
([pricing](https://cloud.google.com/bigquery/pricing)). Every job carries `maximumBytesBilled`, which Google compares
with its estimate before running. Opt-in budgets stop a call before it starts once the day's or the session's budget is
spent. AI/ML (Vertex) functions, Python UDFs and remote functions bill outside the byte cap and need a plan. The full
account: [What it costs](docs/costs.md).

## Security

The plugin's own requests go only to Google: BigQuery's REST API and OAuth endpoints, and, for an `adc` account, the
endpoints its credential type itself uses. `/bigquery-status` and the status dialog make no request. No option holds a
secret, access tokens stay in memory, and the refresh token's DPoP key is a 0600 file in the plugin's state folder. See
[SECURITY.md](SECURITY.md) and [docs/auth.md](docs/auth.md).

## Troubleshooting

Every code the plugin raises, with its next step. `/bigquery-status` shows the plugin's state and the next step.

<!-- errors:start -->
| Code | What happened | Next step |
| --- | --- | --- |
| `ACCOUNT_READ_ONLY` | A commit on a Read account, or on any headless account. Nothing was sent to Google. | Tell the user; only they can sign in again choosing Read and write. |
| `ACCOUNT_REQUIRED` | More than one account is configured and the call named none. | Pass account with one of the configured aliases; bigquery_status lists them. |
| `ACCOUNT_UNKNOWN` | The account alias is not configured. | Pass a configured alias; bigquery_status lists them. |
| `ADC_REFUSED` | Application Default Credentials are refused in a managed (hosted) engine unless allowAdcInHost is set. | Use an interactive account, or ask the host's operator to set allowAdcInHost. |
| `ADC_UNAVAILABLE` | Application Default Credentials found nothing on this machine. | Set GOOGLE_APPLICATION_CREDENTIALS, or run the gcloud command the message names with the bigquery scope. |
| `ADMIN_DISABLED` | Admin statements are turned off by the plugin's admin option. | Ask the user to set admin.enabled to true. |
| `ADMIN_REASON_REQUIRED` | An admin plan was made without reason. | Plan again with reason. |
| `API_DISABLED` | The BigQuery API is off in the project. | Ask the user to enable the BigQuery API in the Google Cloud console, wait a minute, and retry. |
| `AUTH_CLIENT_REQUIRED` | No OAuth client is configured, none was entered in the form, and no earlier sign-in has one. | Enter a Desktop OAuth client in /connect, or set the oauthClient option. |
| `AUTH_REQUIRED` | No usable credential: the account is not signed in, its sign-in expired, the headless variable is unset, or the organisation limits Cloud sessions and wants a new sign-in. | Ask the user to run /connect and choose BigQuery; for a headless account, set the variable the message names. |
| `AUTH_SCOPE_MISSING` | The granted scopes lack one this call needs, such as bigquery unticked on Google's consent screen. Google was not called. | Ask the user to sign in again and approve every scope listed. |
| `BILLING_PROJECT_REQUIRED` | The account has no billing project, so a query cannot run. | Call bigquery_list({}) to see the projects, then set billingProject on the account. |
| `BUDGET_REACHED` | The opt-in budget is spent. | Wait for the reset, or ask the user to raise budget. |
| `BYTES_BILLED_LIMIT` | Google stopped the job at its byte cap; nothing was billed. | Narrow the query, or pass maxBytes up to the ceiling. |
| `CANCELLED` | The call was stopped; a job it started was cancelled, and what it billed is unknown. | Do not retry unless the user asks; bigquery_jobs shows what ran. |
| `CAP_NOT_ENFORCEABLE` | In a source, or with uncappedReads set to refuse: the cap cannot bound this query, and it cannot run from a plan here. | Change the query to read native tables without row access policies. |
| `CATEGORY_MISMATCH` | A plain read sent to bigquery_plan, or a plan committed with another category's tool. | Call the tool the message names. |
| `CLASSIFICATION_DRIFT` | What ran differed from its dry run: another statement type, or a view or routine expansion did not see. It was recorded. | bigquery_jobs shows what ran; report it. |
| `COLUMN_DENIED` | The query reads policy-tagged columns the caller cannot read. | Leave those columns out with SELECT * EXCEPT (…), or ask for Fine-Grained Reader. |
| `COST_CAP` | The estimate is over the cap; the estimate, the cap and hints are given. | Narrow the query, or pass maxBytes up to the ceiling. |
| `DATASET_FENCED` | A referenced object is outside the account's dataset fence, or a person's rule denied it. | Query allowed datasets, or ask the user to change the account's datasets option. |
| `DRY_RUN_INCOMPLETE` | The dry run returned no query statistics, so the checks cannot run. | Retry once; if it repeats, report it. |
| `HOST_UNTESTED` | The OpenCode version is outside the supported range (>=2.4.1 <2.5.0). | Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true. |
| `INPUT_INVALID` | The tool's input does not fit its schema, or a saved query cannot be read as a source; nothing was sent to Google. | Check the input against the tool's schema, then call it again. |
| `JOB_FAILED` | The job failed; Google's reason is in googleError. | Fix the query as googleError says; bigquery_job shows the job. |
| `JOB_TIMEOUT` | The job reached its time limit; the bytes billed so far are given. | Narrow the query, or pass a longer jobTimeoutSeconds. |
| `LEGACY_SQL_REFUSED` | The query is legacy SQL, which the plugin never runs. | Rewrite it in GoogleSQL. |
| `LOCATION_MISMATCH` | The query references objects in different locations. | Query one location at a time, and pass location. |
| `NEEDS_PLAN` | A read whose cost the cap cannot bound, that has external effects, or whose references could not be resolved; the reason is CAP_NOT_ENFORCEABLE, EXTERNAL_EFFECTS or UNRESOLVED_REFERENCE. | Call bigquery_plan({ sql }) and show the user the preview; with their go-ahead, bigquery_query({ planId }) for CAP_NOT_ENFORCEABLE, or the commit tool named for the others. |
| `NOT_BUILT` | This tool is declared but not built yet in this version of the plugin; nothing was sent to Google. | Use another tool, or update the plugin. |
| `NOT_FOUND` | The project, dataset, table, routine or job was not found. | Find the exact name with bigquery_list or bigquery_search. |
| `NOT_RELEASED` | This install is not a tagged release, so the tool did not call Google. | Install a tagged release when one exists. A source checkout does not call Google. |
| `OPTIONS_INVALID` | The plugin options are not valid: an unknown key, a wrong type, a value out of range, a write level on a headless account, or a secret where none belongs. | Fix the plugin options in opencode.json; the message names the option. |
| `PERMISSION_DENIED` | IAM refused the call (the permission is named), or the call needs an approval that a script cannot give. | Ask an admin for the named role; from a script, run the call from a session instead. |
| `PLAN_ALREADY_USED` | The plan was committed, or is being committed. Plans are single-use. | Check the earlier result with bigquery_jobs before planning the change again. |
| `PLAN_CALLER_MISMATCH` | Another session, agent or account created the plan. | Plan again from the session and agent that will commit it. |
| `PLAN_CHANGED` | The commit's dry run differs from the plan's: its type, targets, location, cap or an estimate over 10 percent higher. | Plan again and show the new preview. |
| `PLAN_EXPIRED` | The plan's time limit passed, or a failed commit expired it. | Plan again and show the new preview. |
| `PLAN_NOT_FOUND` | No plan has this planId: it never existed, or its time limit passed and it was removed. | Create a plan with bigquery_plan, then commit its planId. |
| `QUOTA_EXCEEDED` | A Google quota is reached, such as a custom daily query quota. | Quotas reset at midnight Pacific time; try again then. |
| `RATE_LIMITED` | Google's rate limit held after retries; retryAfterSec says how long to wait. | Make the same call later. |
| `RESULTS_EXPIRED` | The job's result table is gone; it expires 24 hours after the original run. | Run the query again. |
| `RULES_NOT_ADDED` | The default permission rules could not be added to the agents, so BigQuery tools may run without asking. | Restart OpenCode. |
| `SAVE_EXISTS` | The save path exists and overwrite is not set. | Choose another path, or pass overwrite: true after the user agrees. |
| `SAVE_LIMIT` | The result is over maxSaveRows or maxSaveBytes; the partial file was removed. | Narrow the query, or ask the user to raise the save limits. |
| `SAVE_PATH_REFUSED` | The save path is outside the allowed roots, or is a symbolic link. | Save to a path inside the project, or one under allowedRoots. |
| `SCRIPT_CAP_REQUIRED` | A script was planned without maxBytes. | Plan it again with maxBytes. |
| `SCRIPT_NOT_DRY_RUNNABLE` | BigQuery cannot dry-run this script, such as one with CREATE TEMP TABLE. | Replace the temporary table with a CTE or a dataset table, then plan again. |
| `SCRIPT_REFUSED` | Scripts are turned off by the scripts option. | Split the script into single statements. |
| `SKILLS_INVALID` | A skill file that ships with the plugin is missing or unreadable. | Reinstall the plugin. |
| `SQL_INVALID` | The dry run or the lexer rejected the SQL; the line and column are given, Google's text is in googleError. | Fix the SQL at that position; bigquery_table shows the names. |
| `STATEMENT_NOT_READ` | bigquery_query got a change or a script. | Call bigquery_plan({ sql }), show the preview to the user, then call the commit tool it names. |
| `STATEMENT_UNKNOWN` | A statement type this version does not classify. | Run it in the Google Cloud console or with bq, and update the plugin. |
| `STATUS_UNAVAILABLE` | The status could not be computed. | Try again in a few seconds; if it persists, restart OpenCode. |
| `TOOLS_NOT_REGISTERED` | The plugin's tools could not be registered with OpenCode. | Restart OpenCode. |
| `UNAVAILABLE` | Google answered with a server error after retries, or the network failed. | Try again later. |
| `WRITE_LEVEL_UNAVAILABLE` | This release ships with the Read and write level turned off, because Google does not keep the two levels apart on a shared client. | Tell the user; changes are made in the Google Cloud console or with bq for now. |
| `WRITE_LEVEL_UNVERIFIED` | The sign-in record says Read and write, but the scopes Google returned at this process's last refresh lack the write marker. Nothing was sent. | Tell the user; they sign in again choosing Read and write and approve Google's consent screen. |
<!-- errors:end -->

## Uninstall

```sh
opencode plugin remove github:we-the-rebel-alliance/bigquery-plugin#v0.0.0
```

## Known limits

- **A Read token can change data outside this plugin.** At Read Google issues a token that can change BigQuery data
  wherever your account may; the plugin never uses it to, but only IAM stops it elsewhere. Grant only
  `roles/bigquery.jobUser` on the billing project and `roles/bigquery.dataViewer` on the data.
- **`adc` and `token` accounts are read-only.** They have no sign-in to bind a level to; `level: "write"` on either is
  refused when the options load.
- **The cap is a guarantee only for a cap-enforceable read.** Native storage, no row access policy on a referenced
  table, a dry-run estimate of `PRECISE` or `UPPER_BOUND`, and no function billed outside bytes. Everything else needs a
  plan whose preview says the cap may not bound it.
- **A table with policy-tagged columns makes the result save-only** unless `policyTagged` is `"allow"`, because a dry
  run names the tables a query reads but no columns.
- **Budgets miss a job nothing polls.** A job started with `wait: 0` and never followed is not counted.
- **Stop can take about 35 seconds if Google never answers the cancel.** The job is still bounded by its byte cap and
  time limit.
- **No live checks have run.** Every test uses invented fixtures and a loopback fake; the live checks need a scratch
  Google Cloud project.

## Links

- [Configuration](docs/configuration.md)
- [Auth and accounts](docs/auth.md)
- [What it costs](docs/costs.md)
- [GoogleSQL](docs/sql.md)
- [Scripting](docs/scripting.md)
- [Architecture](docs/architecture.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [MIT license](LICENSE)
