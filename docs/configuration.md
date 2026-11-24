# Configuration

Unofficial plugin. Not affiliated with Google.

The plugin works without options. Set them on its entry in `opencode.json`:

```json
{
  "plugins": [
    { "package": "github:we-the-rebel-alliance/bigquery-plugin#v0.0.0", "options": { "access": "ask-changes" } }
  ]
}
```

Options are strict: an option the plugin does not know stops it from loading with `OPTIONS_INVALID`, which names the
option, so a typo cannot leave the plugin more open than you meant.

## Options

The options are the contract's (design §12). Every one is optional; the defaults are safe for a read-only account.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `access` | `"all"`, `"ask-changes"` or `"read-only"` | `"all"` | What the default rules allow. See [Permissions](#permissions). |
| `accounts` | object: alias → account | one `default` interactive account | The Google accounts; see [Accounts](#accounts). |
| `oauthClient` | `{ clientId, clientSecret? }` or Google's client JSON | none | The Desktop OAuth client, for every interactive account without its own. |
| `redirectUri`, `callbackPort` | string, integer | none | A relay's redirect; `redirectUri` needs `callbackPort`. |
| `allowAdcInHost` | boolean | `false` | A managed (hosted) engine only: allow Application Default Credentials. |
| `maxBytesBilled` | bytes or a size such as `"10GiB"` | `"10GiB"` | The byte cap every job carries unless a call passes a lower or higher one. |
| `maxBytesCeiling` | bytes or a size | `"100GiB"` | The highest cap a call may ask for. |
| `budget` | `{ daily?, session?, action }` | none | An opt-in budget in bytes billed; `action` is `refuse` (default) or `warn`. Either action adds `BUDGET_WARN` when 10 % or less of the budget is left; `warn` also lets a call run once the budget is spent, where `refuse` blocks it. |
| `onDemandUsdPerTiB`, `slotHourUsd` | number | `6.25`, none | Prices for the estimates. |
| `maxRows`, `maxInlineBytes` | integer, bytes | `50`, `"32KiB"` | What a result carries inline. |
| `maxSaveRows`, `maxSaveBytes` | integer, bytes | `1000000`, `"256MiB"` | The largest file `bigquery_save` writes. |
| `resultsDir`, `allowedRoots` | string, strings | `".bigquery/results"`, `[]` | Where saved files go, and folders outside the project they may go to. |
| `jobTimeoutSeconds`, `uncappedTimeoutSeconds` | integer | `600`, `120` | Job time limits; the second for reads the cap cannot bound. |
| `maxConcurrentJobs` | integer | `4` | Running jobs per account. |
| `scripts` | boolean | `true` | Whether a multi-statement script may be planned. |
| `uncappedReads` | `"ask"` or `"refuse"` | `"ask"` | Whether a read the byte cap cannot bound may run from a plan. With `"ask"` the plugin asserts `bigquery.uncapped_read`: the default rules below ask at `all` and `ask-changes` and deny at `read-only`. `"refuse"` never runs one. |
| `policyTagged` | `"withhold"` or `"allow"` | `"withhold"` | Whether values of policy-tagged columns may reach the model. A query over **any** table with a tagged column returns no rows inline while this is `"withhold"`, because BigQuery's dry run names the tables a query reads but not its columns; the result is save-only instead ([Job resource](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job)). |
| `savedQueries` | object: name → `{ sql, project?, location?, maxBytes?, allowUncached? }` | `{}` | The queries the `bigquery.saved` source may run. On-demand pricing, about $6.25 per TiB billed; at most 1 GiB billed per read unless you raise it (`maxBytes`); cached reads are free. |
| `planTtlSeconds` | integer | `300` | How long a plan can be committed. |
| `admin` | `{ enabled, requireReason }` | both `true` | Admin plans. |
| `allowUntestedHost` | boolean | `false` | Load on an OpenCode release outside `>=2.4.1 <2.5.0`, with a warning in status. |

A saved query that would not use the cache, such as one using `CURRENT_DATE`, is refused unless its `allowUncached` is
`true`: the `bigquery.saved` source runs only cached reads by default, so its cost stays bounded.

### Accounts

Each account takes `mode` (`interactive`, the default; `adc`; `token`), `level` (it can only lower a sign-in's level to
`read`; a headless account is always `read`), `billingProject`, `location`, `datasets` (`{ allow?, deny? }`, patterns
such as `"proj.dataset"`, `"proj.*"` or `"*.sales_*"`), `inline` (`{ deny }`: datasets whose results are save-only),
`oauthClient`, `tokenEnv` (a `token` account's variable), `impersonate` (an `adc` account's service account) and
`scopes`. No option holds a secret.

The dataset fence is checked against every table, view, routine and property graph BigQuery's dry run names, and every
base table a view or routine body reaches, before anything runs. Deny wins; `"proj.*"` and `"*.sales_*"` are
wildcards. A fenced read is refused with `DATASET_FENCED` on every path, sources included.

## Results, saves and status

- **Inline results** carry at most `maxRows` rows (50 by default), `maxInlineBytes` (32 KiB by default) and 200
  characters per cell. A larger result is truncated with `truncated` and a `next` that saves it or asks for another
  page.
- **`bigquery_save`** writes the whole result to a project-relative path under `resultsDir`, or under `allowedRoots`, in
  CSV, JSONL or Parquet: at most `maxSaveRows` and `maxSaveBytes`, streamed, with a SHA-256 and a `charts` hint in the
  answer.
- **A table with policy-tagged columns makes the result save-only**, unless `policyTagged` is `"allow"`; a dataset in
  `inline.deny` does the same with the `INLINE_DENIED` warning. The rows stay in the job's result table, and
  `bigquery_save` reads them from there.
- **Status**: `/bigquery-status` and the TUI dialog make no request to Google; `bigquery_status` reads each account's
  level (which may refresh a token once in a process), shows a Read account's disclosure, and runs the IAM check once
  after a Read sign-in. Its `include`
  adds free checks: `jobs` lists running jobs, `iam` runs the IAM check, and `spend` is the ledger the status already
  reads. See the README's [Known limits](../README.md#known-limits) for what status cannot show yet.

## Permissions

The `access` option generates a block of default rules from the plugin's action table. The block goes right after
each agent's base `* * allow` rule:

1. `bigquery.*` at the change effect, so an action the plugin does not declare is treated like a change;
2. each read (the twelve read tools, `bigquery.saved_list` and `bigquery.probe`) and the permission-only
   `bigquery.read` a source asserts on each operation, allowed;
3. `bigquery.save`, `bigquery.cancel` and the five commits, at the change effect;
4. `bigquery.uncapped_read`, asserted before a read the byte cap cannot bound: `ask` at `all` and `ask-changes`, `deny`
   at `read-only`. An app that writes its own rules decides it there.

The change effect is `allow` at `all`, `ask` at `ask-changes` and `deny` at `read-only`. The last matching rule wins,
so your own rules after the block, an agent's stricter rules and saved approvals still win. A commit also needs a
Read and write sign-in, whatever the rules say.

An agent defined only in your config gets no block, because OpenCode creates it after plugins run. `/bigquery-status`
names it and shows the block: put the block first in that agent's own `permissions`.

## Errors

Every code the plugin raises. Each message reads `CODE: What happened. Next step: What to do.`

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
