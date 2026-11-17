# BigQuery for OpenCode

Connects OpenCode to [Google BigQuery](https://cloud.google.com/bigquery) through BigQuery's REST API, so your agents
can find datasets and tables, estimate a query before running it, run reads under a byte cap, save results to a file
for charts, and plan then commit changes.

Unofficial; not affiliated with Google. BigQuery and Google Cloud are trademarks of Google LLC. The icon is the
family's own tile, not Google's mark.

> **Not yet released.** This is v0.0.1 before its first release. The repository holds the plugin's skeleton and its
> contract: the tools are declared and answer that they are not built yet. Nothing calls Google yet.

## Requirements

- OpenCode `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. A later 2.2 or 2.3 release loads
  too, and the status marks it untested. Outside `>=2.2.3 <2.4.0` the plugin does not load, unless you set
  [`allowUntestedHost`](docs/configuration.md#options).
- macOS or Linux.
- A Google Cloud project with the BigQuery API on, to bill queries to. For read-only use, your admin grants you
  BigQuery Job User on that project and BigQuery Data Viewer on the datasets you read, and nothing more.

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

## Permissions

The `access` option (`all`, the default; `ask-changes`; `read-only`) generates default rules for every agent with a
base allow. See [Permissions](docs/configuration.md#permissions).

### Queries the byte cap cannot bound

A query over a table with row access policies, or over an external table, cannot be bounded by the byte cap, because
BigQuery's own estimate for it is zero or too low. Such a query runs only from a plan whose preview says so, with a
120-second job limit (`uncappedTimeoutSeconds`). In local OpenCode you are asked first at `all` and `ask-changes`, and
it is denied at `read-only`. In Jelly, under Allowed it runs without asking, bounded only by that time limit and your
budget if you set one; under Ask before changes or Read only, Jelly asks you first. A script can never run one.

## Security

See [SECURITY.md](SECURITY.md).

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
| `NEEDS_PLAN` | A read whose cost the cap cannot bound, that has external effects, or whose references could not be resolved; the reason is CAP_NOT_ENFORCEABLE, EXTERNAL_EFFECTS or UNRESOLVED_REFERENCE. | Call bigquery_plan({ sql }) and show the preview; then bigquery_query({ planId }) for CAP_NOT_ENFORCEABLE, or the commit tool named for the others. |
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

## License

MIT. The bundled third-party code and its licences are listed in [NOTICE](NOTICE).
