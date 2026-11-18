# BigQuery for OpenCode

Connects OpenCode to [Google BigQuery](https://cloud.google.com/bigquery) through BigQuery's own REST API, so your
agents can find datasets and tables, estimate a query before it runs, run reads under a byte cap, save results to a file
for charts, and plan then commit changes.

Unofficial; not affiliated with Google. BigQuery and Google Cloud are trademarks of Google LLC. The icon is the
family's own tile, not Google's mark.

> **Not yet released.** This is v0.0.1 before its first release. The nineteen tools are declared in one table and built
> package by package; a tool a build does not carry yet answers `NOT_BUILT`, and nothing is sent to Google for it.

## Requirements

- OpenCode `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7, 2.3.0, 2.3.1 and 2.3.2. A later 2.2 or 2.3
  release loads too, and the status marks it untested. Outside `>=2.2.3 <2.4.0` the plugin does not load, unless you set

  [`allowUntestedHost`](docs/configuration.md#options).
- macOS or Linux.
- A Google Cloud project with the BigQuery API on, to bill queries to. For read-only use, your admin grants you
  BigQuery Job User on that project and BigQuery Data Viewer on the datasets you read, and nothing more
  ([access control](https://cloud.google.com/bigquery/docs/access-control)).

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-bigquery#v0.0.1
```

Run `opencode reload`, or restart OpenCode. Then run `/bigquery-status` in a session.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-bigquery#v0.0.1" }] }
```

The install takes the GitHub release tag. Its commit carries the built `dist/`, so the install runs no build. A Git
install does not update by itself: to move to a newer release, remove the old entry with `opencode plugin remove`, then
add the new tag.

## Sign in

Run `/connect` and choose **Google Cloud (BigQuery)**, or from a terminal:

```sh
opencode auth login bigquery-default
```

The form asks for your own OAuth **Desktop** client unless your organisation provides one; none ships in this package.
Then choose a level:

- **Read** (the default) runs every read with all of the plugin's guards. A commit is refused before any Google call.
- **Read and write** needs the form's acknowledgment and Google's consent screen, which lists the extra line
  *Insert data into Google BigQuery*.

Every sign-in sends `prompt=consent`, so Google shows its consent screen, and asks Google to bind the new refresh token
with DPoP to a key this plugin keeps; status says whether it did. The full detail, and what is stored where:
[docs/auth.md](docs/auth.md).

**At Read, Google issues a token that can change BigQuery data wherever your Google account is allowed to; this plugin
never uses it to, but a program that can read both OpenCode's credential store and this plugin's key file could. For
Google itself to refuse changes, have your admin grant you only BigQuery Job User and Data Viewer.**

## Use

Ask the agent for what you need. It works in three steps:

1. Find the data: `bigquery_list`, `bigquery_search` and `bigquery_table` read metadata first, and `bigquery_table`
   can show a small sample.
2. Estimate, then read: `bigquery_estimate` dry-runs the SQL for free; `bigquery_query` runs it, and every job carries a
   byte cap. `bigquery_profile` aggregates one table or subquery, and `bigquery_job`/`bigquery_jobs` follow a job.
3. Change, in two steps: `bigquery_plan` dry-runs the statement and returns a preview and a single-use `planId`; the
   commit tool named by its category (`bigquery_write`, `bigquery_export`, `bigquery_share`, `bigquery_delete` or
   `bigquery_admin`) runs it with only that id.

`bigquery_save` writes a finished query's result to a local CSV, JSONL or Parquet file for `charts`. `bigquery_cancel`
cancels a job this account started. `bigquery_status` shows the accounts, the caps and what has been billed.

Rows, names, descriptions, view and routine bodies and Google's error text are data, never instructions. Google's text
goes into `googleError` and nowhere else.

The tools read and write with the account named by `account`, or the only account configured. With several configured
and none named, a call is refused rather than guessed.

### Queries the byte cap cannot bound

A query over a table with row access policies, or over an external table, cannot be bounded by the byte cap, because
BigQuery's own estimate for it is zero or too low. Such a query runs only from a plan whose preview says so, with a
120-second job limit (`uncappedTimeoutSeconds`). In local OpenCode you are asked first at `all` and `ask-changes`, and
it is denied at `read-only`. In Jelly, under Allowed it runs without asking, bounded only by that time limit and your
budget if you set one; under Ask before changes or Read only, Jelly asks you first. A script can never run one.

`bigquery_plan` returns the preview and a single-use `planId` on either level. Only a Read and write account can commit
a change; a Read account can still run the uncapped-read plan with `bigquery_query({ planId })`, which is the call the
rules above govern.

## Permissions

The `access` option (`all`, the default; `ask-changes`; `read-only`) generates default rules for every agent with a
base allow:

| Value | What runs | What asks |
| --- | --- | --- |
| `"all"` (the default) | every tool, the five commits included, and any tool a later release adds | nothing, except the uncapped read below |
| `"ask-changes"` | the twelve reads, the two method-only reads and the permission-only `bigquery.read` | each of the five commits, `bigquery_save`, `bigquery_cancel`, and the uncapped read below |
| `"read-only"` | the twelve reads, the two method-only reads and the permission-only `bigquery.read` | nothing: those seven are denied, and the uncapped read is denied too |

The table is the block the plugin generates for local OpenCode. The uncapped read is the one run-time ask,
`bigquery.uncapped_read`: local rules ask at `all` and `ask-changes` and deny at `read-only`. In Jelly, Jelly's own
rules decide it: unasked at Allowed, asked at Ask before changes and Read only.

The rules go directly after each agent's base `{ "action": "*", "resource": "*", "effect": "allow" }`; a later rule of
yours still wins, and a commit also needs a Read and write sign-in whatever the rules say. Agents defined only in your
config get no block; `/bigquery-status` names them. Details and the rule block: [Configuration](docs/configuration.md#permissions).

## Status, doctor and sign-out

- `/bigquery-status` posts the plugin's status: access, the accounts and their billing projects, the dataset fences,
  the byte caps, what was billed today, the agents without the default rules, and the next step. The TUI's
  **BigQuery: Status** dialog shows the same rows. Neither makes a request to Google.
- `bigquery_status` is the model's version of the same, plus each account's level as the plugin's two §3.1 checks decide
  it, the reason a Read and write account is read, and a Read account's disclosure wording. Reading a level may refresh a token once in a process. `include: ["jobs"]` adds this account's running jobs (a
  free `jobs.list`), `include: ["iam"]` runs the IAM check below, and `include: ["spend"]` is the ledger the status
  always reads. The IAM check also runs once, by itself, at the first `bigquery_status` after a Read sign-in.
- `/bigquery-doctor` makes a few free calls per account: one `projects.list`, one dry run of `SELECT 1`, one
  `datasets.list`, the level check and the IAM check.
- `/bigquery-signout [alias]` deletes the account's DPoP key and forgets its tokens in memory. OpenCode keeps the
  stored refresh token until `/connect` or `opencode auth logout bigquery-<alias>` removes it; the command says which.

### The IAM check

At the first `bigquery_status` after a Read sign-in, and on `bigquery_status({ include: ["iam"] })` and
`/bigquery-doctor`, the plugin calls `tables.testIamPermissions` for `bigquery.tables.updateData`, `create` and `delete`
on the first table of each allowed dataset, up to 10 (free; it reports inherited grants). A hit is the
`IDENTITY_CAN_WRITE` warning, naming the table. Its limit: whether the identity may create datasets at project level
cannot be checked, because Resource Manager's `projects.testIamPermissions` needs scopes this plugin does not request.

## What it costs

On-demand, about **$6.25 per TiB scanned**, with the first TiB each month free and a 10 MB minimum per query
([pricing](https://cloud.google.com/bigquery/pricing)). `LIMIT` does not reduce the bytes read, and the cache is free
([cached results](https://cloud.google.com/bigquery/docs/cached-results)).

Every job carries `maximumBytesBilled`, which Google compares with the estimate it makes before running: a query over
the cap fails without a charge ([best practices for costs](https://cloud.google.com/bigquery/docs/best-practices-costs)).
Each result says what was billed, and `bigquery_status` adds it up from a local ledger. Opt-in budgets in bytes billed
stop a call before it starts once the day's or the session's budget is spent.

AI/ML (Vertex) functions, Python UDFs and remote functions bill outside the byte cap and always need a plan. Scripts
need an explicit `maxBytes`. The full account: [What it costs](docs/costs.md).


## Security

The plugin's own requests go only to Google: BigQuery's REST API and OAuth endpoints, and, for an `adc` account, the
endpoints its credential type itself uses (the metadata server, `iamcredentials.googleapis.com` for impersonation,
`sts.googleapis.com` for an external-account credential). `/bigquery-status` and the status dialog make no request. No
option holds a secret, access tokens stay in memory, and the refresh token's DPoP key is a 0600 file in the plugin's
state folder. See [SECURITY.md](SECURITY.md) and [docs/auth.md](docs/auth.md).

Inline results reach your model's provider. A dataset whose contract forbids that can be made save-only with
`accounts.<alias>.inline.deny`, and any table with policy-tagged columns is save-only anyway (see Known limits).

## Troubleshooting

Every code the plugin raises, with its next step. `/bigquery-status` shows the plugin's state and the next step.

<!-- errors:start -->
| Code | What happened | Next step |
| --- | --- | --- |
| `ACCOUNT_READ_ONLY` | A commit on a Read account, or on any headless account. Nothing was sent to Google. | Tell the user; only they can sign in again choosing Read and write. |
| `ACCOUNT_REQUIRED` | More than one account is configured and the call named none. | Pass account with one of the configured aliases; bigquery_status lists them. |
| `ACCOUNT_UNKNOWN` | The account alias is not configured. | Pass a configured alias; bigquery_status lists them. |
| `ADC_REFUSED` | Application Default Credentials are refused in hosted Jelly unless allowAdcInHost is set. | Use an interactive account, or ask the host's owner to set allowAdcInHost. |
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
| `HOST_UNTESTED` | The OpenCode version is outside the supported range (>=2.2.3 <2.4.0). | Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true. |
| `INPUT_INVALID` | The tool's input does not fit its schema, or a saved query cannot be read as a source; nothing was sent to Google. | Check the input against the tool's schema, then call it again. |
| `JOB_FAILED` | The job failed; Google's reason is in googleError. | Fix the query as googleError says; bigquery_job shows the job. |
| `JOB_TIMEOUT` | The job reached its time limit; the bytes billed so far are given. | Narrow the query, or pass a longer jobTimeoutSeconds. |
| `LEGACY_SQL_REFUSED` | The query is legacy SQL, which the plugin never runs. | Rewrite it in GoogleSQL. |
| `LOCATION_MISMATCH` | The query references objects in different locations. | Query one location at a time, and pass location. |
| `NEEDS_PLAN` | A read whose cost the cap cannot bound, that has external effects, or whose references could not be resolved; the reason is CAP_NOT_ENFORCEABLE, EXTERNAL_EFFECTS or UNRESOLVED_REFERENCE. | Call bigquery_plan({ sql }) and show the user the preview; with their go-ahead, bigquery_query({ planId }) for CAP_NOT_ENFORCEABLE, or the commit tool named for the others. |
| `NOT_BUILT` | This tool is declared but not built yet in this version of the plugin; nothing was sent to Google. | Use another tool, or update the plugin. |
| `NOT_FOUND` | The project, dataset, table, routine or job was not found. | Find the exact name with bigquery_list or bigquery_search. |
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
opencode plugin remove github:joe-broadhead/opencode-bigquery#v0.0.1
```

## Known limits

Each of these is deliberate, measured, or not built yet. None is silent: the result or the status says so where it
applies.

**Sign-in and credentials**

- **A Read token can change data outside this plugin.** At Read Google issues a token that can change BigQuery data
  wherever your account may; the plugin never uses it to, but only IAM stops it elsewhere. Grant only
  `roles/bigquery.jobUser` on the billing project and `roles/bigquery.dataViewer` on the data — nothing with
  `bigquery.tables.updateData`, `create` or `delete`. The IAM check samples at most 10 tables and cannot check
  project-level dataset creation.
- **`adc` and `token` accounts are read-only**, full stop: they have no sign-in to bind a level to. `level: "write"` on
  either is refused when the options load.
- **Every interactive sign-in sends `prompt=consent`** and replaces the DPoP key and refresh token. Google shows its
  consent screen, except for a Workspace app the admin marked trusted, which shows no granular screen and grants all the
  requested scopes or none ([OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
  If Google does not bind the token to this device (status records `bound` or `unbound` once the auth port exposes it),
  the credential store alone is enough to use it. The key is a 0600 file in the state folder, not the OS keystore. A
  Workspace admin's Cloud session limit makes a refresh fail with `AUTH_REQUIRED`; the fix is the admin's trusted-app
  exemption ([set session length for Google Cloud services](https://support.google.com/a/answer/9368756)).
- **The plugin never calls Google's `/revoke`**, because it would revoke every token of the OAuth client, signing you
  out of other apps on it. Sign-out is local: a *bound* old token is unusable without the deleted key; an *unbound*
  one stays valid at Google until it expires or you remove the app at
  <https://myaccount.google.com/permissions>, and the result says so. Very frequent re-sign-ins on a client shared with
  other apps can retire an old token of theirs, because Google retires the oldest
  ([OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
- **Status shows a Read account's disclosure in the binding's own wording and the failed §3.1 check's reason as a
  `next` step, but not the granted scopes or the last three errors**, and `/bigquery-status` and the TUI do not show
  each account's level or run the IAM check: reading a level may refresh a token, which only `bigquery_status` does.
- **A script cannot answer an ask.** The tools RPC refuses `bigquery_query({ planId })`: an uncapped read runs only from
  a session's tool, where the user sees its preview.

**The byte cap and cost**

- **The cap is a guarantee only for a cap-enforceable read**: native BigQuery storage, no row access policy on any
  referenced table, a dry-run estimate of `PRECISE` or `UPPER_BOUND`, and no function billed outside bytes. Everything
  else needs a plan whose preview says the cap may not bound it, with a 120-second job limit.
- **Any table with policy-tagged columns makes the result save-only** — no inline rows, even when the query names only
  untagged columns — because a dry run's `statistics.query` names the tables a query reads but **no columns**
  ([Job resource](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job)). Only `policyTagged: "allow"` turns
  that off. Inline results also stay out of a dataset in `accounts.<alias>.inline.deny`.
- **A cap-unenforceable read under Jelly's Allowed runs without asking**, bounded only by `uncappedTimeoutSeconds`
  (120 s) and your budget if you set one; BigQuery bills what it actually reads, which can exceed the cap. In local
  OpenCode the plugin's rules ask at `all` and `ask-changes` and deny at `read-only`.
- **Budgets miss a job nothing polls.** The ledger records a finished job when the plugin reads its page; a job started
  with `wait: 0` and never followed is not counted, and the reconciliation with `INFORMATION_SCHEMA.JOBS_BY_USER` is not
  built. Parallel calls can overspend by up to `maxConcurrentJobs` × what the budget had left.
- **Scripts are bounded less tightly**: the dry run stops at the first `CALL`, DDL, `EXECUTE IMMEDIATE` or
  `FOR`/`IF`/`WHILE`, and until live check L15 settles it the cap may apply to each child statement, so the bound is up
  to one cap per statement. Scripts require `maxBytes` and run with a 300-second limit.

**The read path**

- **Expansion is capped**: at most 32 views and routines, 3 levels deep, and 256 metadata lookups per read, and a
  dry-run list of 50 or more objects is treated as possibly cut (Google documents that limit for property graphs only:
  [Job resource](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job)). Past any of them the read goes to a
  plan, so a query over a deep chain of views cannot run inline.
- **A bare column named like a statement keyword is refused**: the lexer reads `commit`, `begin`, `rollback`, `call`
  and `execute immediate` anywhere outside a routine definition as a statement that runs hidden text, so a `SELECT` over
  a column called `commit` answers `STATEMENT_NOT_READ`. Quote it (`` `commit` ``) or rename it; it is a lexer false
  positive, not a BigQuery rule.
- **A 0-byte estimate is never trusted**: a query that legitimately estimates 0 bytes over a non-empty table, or a
  row-policy probe that cannot read a column, is treated as row-secured and goes to a plan.
- **Wildcard tables, property graphs and table-typed routine arguments fail closed**: the plugin cannot see what they
  read, so the read needs a plan.
- **The dry run does not report columns**, and a view or SQL routine whose body cannot be dry-run (authorised, legacy,
  or a statement other than a `SELECT`) is unresolved: the read needs a plan. Temporary functions are refused outright,
  and a JavaScript UDF is treated like an external effect, so it needs a plan and a Read and write account.
- **A routine body's tables are followed conservatively**: whether a dry run still lists a table in a branch that a
  typed `NULL` argument folds away is undocumented (live checks L7 and L13, `TODO(L7, L13)` in `guards/read.ts`), so a
  body whose tables cannot be followed goes to a plan.
- **`bigquery_job` fails closed on any job it did not prepare**: a view, routine, script or procedure puts the result
  in save-only, and the fence still applies. Its `jobs.get` lists are not subject to the 50-entry rule.
- **Row-policy probes are a second request path**, bounded only by the 256 lookups, one metadata call and one dry run
  per table (one per column on a column-level denial), each cached 10 minutes.
- **An uncapped-read plan is re-checked without its unresolved references**: the fence, type, effects, location and
  estimate are re-checked before it runs, but an object that becomes unresolved between plan and commit does not by
  itself make it `PLAN_CHANGED`.
- **A region- or project-qualified `INFORMATION_SCHEMA` reference is refused under an allow fence**, and
  `bigquery_search` reads at most 10 datasets, billed at least 10 MB per view it reads.
- **Samples and inline results are small by design**: a sample is at most 20 rows with tagged columns withheld, and a
  view, external or row-secured table says `unavailable` with the reason; a result carries at most 50 rows, 32 KiB and
  200 characters per cell inline; pages are fetched with `maxResults = maxRows + 1`. `bigquery_profile`'s `samplePercent`
  is refused on a row-secured table.
- **View and routine expansion is cached 60 seconds per account**: a view redefined inside that window is caught after
  the run by comparing the finished job's lists, which records `CLASSIFICATION_DRIFT` and drops the cache.

**The runtime**

- **Stop can take about 35 seconds if Google never answers the cancel**: the cancel has a 15-second limit, then two
  10-second `jobs.get` tries and a second cancel. The job is still bounded by its byte cap and time limit, and what it
  billed is reported as unknown.
- **A `jobs.list` page that skips a location says so in `unreachable[]`**: the port carries it, and the `bigquery.jobs`
  source fails the read with `UNAVAILABLE` while the location is unreachable (for up to 7 days), then answers
  `window-truncated` gaps until it returns. Nothing is lost; a job still running there is listed when it comes back.
- **A 401 re-sends the token already cached**, with no forced refresh, and no response over 10 MiB is read; at most 8
  requests are in flight per process.

**Sources**

- **Continuous queries never finish, so they are not in the `bigquery.jobs` source.** A job still unfinished 24 hours
  after it was created is no longer tracked: the read answers a `gap` with `window-truncated`, once. Paging is by
  creation time, and one `events_list` call makes at most 20 `jobs.list` walk calls (`LIST_CALLS`), answering fewer
  events with `more: true`. `jobs.delete` is not reported as a removal.
- **The `bigquery.saved` source** runs at most 1 GiB per read by default, refuses a query whose cost cannot be bounded
  or that cannot use the cache (unless `allowUncached`), and counts each read in the budget. `bigquery_save` writes
  NUMERIC and BIGNUMERIC values as text in JSONL and Parquet.

**Changes**

- **A change's target is not fenced or asserted for most statements.** BigQuery's dry run names a target only for
  CREATE/DROP TABLE or VIEW, schema statements and CREATE/DROP routine
  ([Job resource](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job)); for DML, `ALTER`, `TRUNCATE`,
  `LOAD DATA`, scripts and `CALL` it names none, and whether `referencedTables` includes the table a DML statement
  writes is unknown (live checks L7 and L13). A fence therefore bounds what a change **reads**, not what it writes; the
  preview and IAM are the bounds there. A person's per-table rule is not consulted for such a target either.

**Not measured yet**

- **The live checks have not run.** There is no scratch project yet, so L1 (session limits), L3 (**a release gate**: a
  `jobs.insert` dry run fills `statementType`, accuracy and all four `referenced*` lists; if any list is never filled,
  the fence and side-effect checks ship refusing with `DRY_RUN_INCOMPLETE`), L4, L5, L7 (row-policy probes and
  required-partition-filter floors), L8, L10, L11, L12, L13, L14, L15 and L16 (**a release gate**: Google must not
  return `bigquery.insertdata` on a Read sign-in; if it does, this release ships with `WRITE_LEVEL_UNAVAILABLE` and
  changes are made in the console or `bq`). No test calls Google: every test uses invented fixtures and a loopback
  fake.

## Links

- [Configuration](docs/configuration.md)
- [Auth and accounts](docs/auth.md)
- [What it costs](docs/costs.md)
- [GoogleSQL](docs/sql.md)
- [Scripting](docs/scripting.md)
- [Jelly](docs/jelly.md)
- [Architecture](docs/architecture.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [MIT license](LICENSE)
