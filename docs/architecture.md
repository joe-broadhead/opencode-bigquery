# Architecture

## Layers

```
setup (src/index.ts)
  assertHost                     refuse an untested OpenCode release
  loadOptions                    the options, parsed with defaults
  attachAuthHost                 the credential store both the port and the sign-in share
  registerPluginAccounts         one integration per alias, through the contract's accounts module
  createProvider                 the BigQuery client, the ledger and the clock
  createHandlers                 the one handler table
  register                       tools, Code Mode, RPC, access rules and the bus, from that table
```

The handlers never touch a tool, an RPC registration or a permission rule: `register` owns doors 1–3 and the generated
access rules. A handler receives its input, the resolved `account`, the session and its signal, `call.bus`, and the
plan when the call commits one.

## The provider client

`src/provider/` is the only layer that talks to Google. `endpoints.ts` names every URL once; `http.ts` sends JSON over
`fetch` with a bearer token from the auth port, at most eight requests in flight, jittered retries for idempotent calls
and runs that carry a client job id, and Google's failures mapped to the plugin's codes. `bigquery.ts` is the REST v2
surface: `jobs.insert` for dry runs and runs, `jobs.getQueryResults` for rows, `jobs.get`/`jobs.list`, `jobs.cancel`,
`projects.list`, `datasets.list`, `tables.list`/`tables.get`, `tabledata.list`, `routines.list`/`routines.get`,
`rowAccessPolicies.list` and `tables.testIamPermissions`. The request body is built from the port's own fields, so the
read path cannot be turned into something else by passing extra keys: no destination table, write disposition, session
or connection property is ever sent.

## The read path

Every billed read goes through `guards/read.ts`:

1. the lexer refuses what it cannot read and raises the statement's kind (legacy SQL, `CALL`, transactions, external
   effects, temporary functions);
2. a free dry run answers the statement type, the referenced objects and an estimate that is never a cache hit;
3. the references are expanded: each view's and SQL routine's body is dry-run too, so the fence and the policy rule see
   what the statement actually reads;
4. the account's dataset fence, the policy-tag rule and the byte cap are checked; a condition the cap cannot bound is
   refused with a next step naming `plan_query`;
5. the run carries the exact text, a client job id (`oc_<uuid>`), `maximumBytesBilled`, labels and a time limit;
6. the answer is compared with its dry run (`CLASSIFICATION_DRIFT`), rows are shaped to the inline budget, and what
   Google billed is written to the ledger.

## What is cached

Only metadata, in memory, for 60 seconds: table facts and routine bodies used by expansion and the policy rule, and
row-access-policy verdicts for 10 minutes. Tokens live in memory for their lifetime. No row, no query result and no
provider answer is cached by the plugin: a `reader` app keeps its own cache and cursors.

## OpenCode APIs used

`@opencode/plugin` 2.4.1 only: `ctx.app.version`, `ctx.options`, `ctx.integration` (the credential store),
`ctx.agent.list()` through the contract's status call, and what `register` uses (tools, RPC, permission, session). No
private host package is imported.

## Plans

A planner returns the preview and the statement, and the contract's `register` mints the plan id, keeps the answer for
15 minutes and spends it once. The commit receives that answer as `call.plan`, re-runs the dry run and refuses
`PLAN_CHANGED` when the statement type, its targets, its location, whether the cap bounds it, or an estimate more than
10 % higher differ. Nothing is written to disk for a plan.

## Known limits (live checks)

These behaviours are implemented conservatively and their exact provider answers are confirmed against a real Google
Cloud project; none of them lets a call run more openly than the guarded path above.

- **Cloud session limits (L1).** The exact `invalid_grant` subtype and description Google uses under a Cloud session
  limit, and the number of hours it states, are unconfirmed. Any reauthentication subtype is treated as a sign-in need,
  so a limit surfaces as `NEEDS_SIGN_IN` rather than a failed refresh.
- **DML targets (L7, L13).** BigQuery does not say whether a DML statement's `referencedTables` lists the table it
  writes. When the dry run names no other target, the plugin uses that list as the destination and a dataset fence
  refuses a DML whose target cannot be verified. Whether a query's `referencedTables` already includes the base tables of
  its views and routines is also unconfirmed; expansion dry-runs each body, so the answer does not depend on it.
- **Row-secured tables (L7).** The `tabledata.list` probe with no rows assumes Google refuses it on a row-secured table
  without the `TRUE` filter; a refusal is read as row-secured, and when it answers the dry-run signal decides. Either way
  an unknown answer makes the cap unenforceable and sends the read to `plan_query`.
- **Dry-run location (L8).** A dry-run answer is expected to carry `jobReference.location`. When it does not, the run is
  sent without a location and Google infers it from the datasets, which is only safe in a single-region US or EU
  location until a live check confirms it.
- **DPoP binding (L16).** The exact error code of the 400 Google returns for a bound token whose proof is missing is not
  recorded; the sign-in treats any `invalid_grant` as a need to sign in again and writes a new device key.
