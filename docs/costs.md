# What it costs

Unofficial plugin. Not affiliated with Google.

BigQuery bills the query, not the tool call. Every price and limit here is Google's, from its own pages (fetched
17 November 2026), and the plugin's estimates use these numbers.

## On-demand pricing

| Fact | Value | Google's page |
| --- | --- | --- |
| Price per byte scanned | about **$6.25 per TiB**, US and EU multi-region | [Pricing](https://cloud.google.com/bigquery/pricing) |
| Free each month | the first **1 TiB** of query data | [Pricing](https://cloud.google.com/bigquery/pricing) |
| Minimum billed per query and per table | **10 MB** | [Pricing](https://cloud.google.com/bigquery/pricing) |
| `LIMIT` | does **not** reduce the bytes read | [Best practices for costs](https://cloud.google.com/bigquery/docs/best-practices-costs) |
| Errors and cache hits | free | [Pricing](https://cloud.google.com/bigquery/pricing) |
| A cancelled query | may still bill for what it read | [`jobs.cancel`](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel) |

`INFORMATION_SCHEMA` views bill at least **10 MB** and never use the cache
([Introduction to INFORMATION_SCHEMA](https://cloud.google.com/bigquery/docs/information-schema-intro)). The cache lasts
about 24 hours, and it is not used for non-deterministic functions, a destination table, a non-GCS external source or a
row-secured table ([Cached results](https://cloud.google.com/bigquery/docs/cached-results)).

Editions (Standard, Enterprise, Enterprise Plus) bill slot-hours instead; there, bytes billed are informational. The
plugin's estimates stay in bytes and dollars at `onDemandUsdPerTiB`; read [Pricing](https://cloud.google.com/bigquery/pricing)
for the slot rates.

## The byte cap, and what it guarantees

Every job the plugin runs carries `maximumBytesBilled`: at most the call's `maxBytes`, otherwise `maxBytesBilled`
(10 GiB by default), never more than `maxBytesCeiling` (100 GiB), and never more than an opt-in budget leaves. Google
compares it with the estimate it makes **before** the query runs, and a query over the limit fails without a charge
([Best practices for costs](https://cloud.google.com/bigquery/docs/best-practices-costs)).

That is a guarantee only when BigQuery's estimate is exact or an upper bound, which it is for native storage without a
row access policy ([Best practices for costs](https://cloud.google.com/bigquery/docs/best-practices-costs); a dry run
over a row-secured table estimates **0** bytes and a federated source's estimate is a lower bound — see
[Run a query](https://cloud.google.com/bigquery/docs/running-queries)). So the plugin checks each read's
cap-enforceability before running it, and sends every other read to a plan whose preview says the cap may not bound it,
with a 120-second job limit (`uncappedTimeoutSeconds`). BigQuery bills what the query actually reads, which can be more
than the cap in that case.

The plugin never raises the ceiling from a tool call: `maxBytes` above `maxBytesCeiling` is refused with `INPUT_INVALID`.

## What bills outside the cap

- **AI/ML functions** (`ML.*`, `AI.*`, Vertex AI) pass their cost through to Vertex AI
  ([Pricing](https://cloud.google.com/bigquery/pricing)).
- **Python UDFs** reach services through a connection and bill separately
  ([Python UDFs](https://cloud.google.com/bigquery/docs/user-defined-functions-python)).
- **Remote functions** call a Cloud Run or Cloud Functions endpoint, which bills on its own.

A read that uses any of them is an external effect: it needs a plan and a Read and write account. A JavaScript UDF is
treated the same way by this version, although it runs sandboxed inside BigQuery (Known limits).

## Scripts

A multi-statement query is a script. BigQuery's dry run stops at the first `CALL`, DDL statement, `EXECUTE IMMEDIATE`
or `FOR`/`IF`/`WHILE` ([Multi-statement queries](https://cloud.google.com/bigquery/docs/multi-statement-queries)), so
the preview says what the estimate covered. Scripts require an explicit `maxBytes` and run with a 300-second job limit;
until live check L15 settles whether the parent's cap bounds each child statement or the total, the preview says the
bound is up to one cap per statement.

## Budgets

Budgets are opt-in, in bytes billed, over a local day and/or the session:

```json
{ "plugins": [{ "package": "github:we-the-rebel-alliance/bigquery-plugin#v0.0.0", "options": { "budget": { "daily": "5GiB", "action": "refuse" } } }] }
```

`action: "refuse"` answers `BUDGET_REACHED` before a call starts once the budget is spent; `"warn"` lets the call run
and says how much is left. Under either action the plugin adds `BUDGET_WARN` once 10 % or less of the budget is left.
The bytes come from each finished job's actual `totalBytesBilled`, recorded in
`$XDG_STATE_HOME/bigquery-plugin/spend.jsonl` (local days, one line per job, no session id — a hash).
`bigquery_status` and `/bigquery-status` show today's bytes and dollars.

A job nothing polls is not in the ledger, and the reconciliation with Google's `INFORMATION_SCHEMA.JOBS_BY_USER` is not
built; parallel calls can overspend by up to `maxConcurrentJobs` × what the budget had left (Known limits).

## Reading a result's cost

Every billed result carries `bytesProcessed`, `bytesBilled`, `costUsd` and `cacheHit`. `bigquery_estimate` answers the
same before anything runs, with the reference list and the hints: a partitioned table scanned at 90 % or more, a
clustered table's cluster columns, a `LIMIT` over a full scan, `SELECT *`, and a repeated query's cache.

## Quotas

Google's quotas and custom quotas apply on top of every cap here
([Quotas and limits](https://cloud.google.com/bigquery/quotas), [Custom quotas](https://cloud.google.com/bigquery/docs/custom-quotas)).
A custom daily query quota resets at midnight Pacific time. The plugin answers `QUOTA_EXCEEDED` or `RATE_LIMITED` and
names the reset.
