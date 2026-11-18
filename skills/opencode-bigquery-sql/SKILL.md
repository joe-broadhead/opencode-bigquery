---
name: opencode-bigquery-sql
description: GoogleSQL for BigQuery - partition filters, wildcards, QUALIFY, UNNEST, SAFE functions, APPROX aggregates, TABLESAMPLE, INFORMATION_SCHEMA and query parameters, with worked examples.
---
If BigQuery's tools are absent, run `/connect` and choose BigQuery to sign in, or on Jelly call jelly_connection_request.

# GoogleSQL

The plugin runs GoogleSQL, BigQuery's standard SQL ([Query syntax](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax)).
Legacy SQL is refused (`LEGACY_SQL_REFUSED`). BigQuery bills the bytes a query **reads**, so these rules decide the cost
before the query runs:

1. **Filter the partition column.** A filtered partitioned table's estimate is precise and only those partitions are
   read ([Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables)).
2. **Name the columns.** `SELECT *` reads every column. `LIMIT` does not reduce the bytes read
   ([Best practices for costs](https://cloud.google.com/bigquery/docs/best-practices-costs)).
3. **Aggregate in BigQuery**, not in the model: `COUNT`, `SUM`, `APPROX_COUNT_DISTINCT`, `APPROX_QUANTILES`.
4. **Estimate first** with `bigquery_estimate`; it is a free dry run.
5. **Save and chart** a large result with `bigquery_save` instead of asking for thousands of rows.

## Parameters

Pass values as parameters, never pasted into the SQL text
([Parameterized queries](https://cloud.google.com/bigquery/docs/parameterized-queries)):

```sql
SELECT word, SUM(word_count) AS n
FROM `bigquery-public-data.samples.shakespeare`
WHERE corpus = @corpus AND word_count > @min
GROUP BY word ORDER BY n DESC LIMIT 10
```

`query({ sql, params: { corpus: "hamlet", min: 10 } })` sends `@corpus` and `@min`. Positional `?` parameters take an
array. STRING, BOOL, INT64, FLOAT64 and arrays of them are inferred; a STRUCT or NULL needs an explicit type, and an
INT64 above 2^53 loses precision as a JSON number, so pass it as a string and `CAST` it.

## Dates and partitions

A date-partitioned table reads only the partitions the filter names:

```sql
SELECT COUNT(*) AS events
FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*`
WHERE _TABLE_SUFFIX BETWEEN '20201101' AND '20201130'
  AND event_name = 'purchase'
```

A **wildcard table** is a change to this plugin's guards: nothing can tell which tables a `_TABLE_SUFFIX` selection
reads, so the read needs a plan. Prefer one table or an `INFORMATION_SCHEMA` view for a read that should run inline.
`requirePartitionFilter` tables refuse a query with no partition filter; `_PARTITIONTIME` is the ingestion-time
pseudo-column ([Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables)).

## QUALIFY

`QUALIFY` filters a window function's result, so "one row per key" needs no subquery
([QUALIFY](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax#qualify_clause)):

```sql
SELECT repo_name, commit AS latest_commit, author.date AS authored
FROM `bigquery-public-data.github_repos.commits`
WHERE author.date >= '2020-01-01'
QUALIFY ROW_NUMBER() OVER (PARTITION BY repo_name ORDER BY author.date DESC) = 1
LIMIT 100
```

## UNNEST

`UNNEST` turns an array or a repeated field into rows ([Querying arrays](https://cloud.google.com/bigquery/docs/querying-arrays)):

```sql
SELECT event_name, param.key AS key, param.value.string_value AS value
FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20201101`,
     UNNEST(event_params) AS param
WHERE event_name = 'page_view'
LIMIT 20
```

`ARRAY_AGG(x IGNORE NULLS ORDER BY t LIMIT 10)` builds an array back, and `(SELECT AS STRUCT …)` nests a struct. Never
use a bare table alias as a value (`SELECT t`, `TO_JSON(t)`, `ARRAY_AGG(t)`) over a table with tagged columns: the
result becomes save-only.

## SAFE functions

A `SAFE.` prefix turns an error into `NULL` for that row instead of failing the query
([SAFE](https://cloud.google.com/bigquery/docs/reference/standard-sql/functions-and-operators#safe_prefix)):

```sql
SELECT SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
       SAFE_CAST(payload AS INT64) AS n
FROM `bigquery-public-data.samples.shakespeare`
```

`SAFE_CAST`, `SAFE_DIVIDE` and `SAFE_OFFSET` are the common ones. `SAFE.AI.…` and `SAFE.ML.…` are still external
effects.

## Approximate aggregates

Cheaper on large tables and exact enough for a profile
([Approximate aggregate functions](https://cloud.google.com/bigquery/docs/reference/standard-sql/approximate_aggregate_functions)):

```sql
SELECT APPROX_COUNT_DISTINCT(word) AS words,
       APPROX_QUANTILES(word_count, 100)[OFFSET(50)] AS median_count
FROM `bigquery-public-data.samples.shakespeare`
```

## TABLESAMPLE

```sql
SELECT word, word_count
FROM `bigquery-public-data.samples.shakespeare` TABLESAMPLE SYSTEM (1 PERCENT)
LIMIT 50
```

`TABLESAMPLE` does not combine with row-level security, so a sample of a row-secured table is refused
([Row-level security](https://cloud.google.com/bigquery/docs/row-level-security-intro)). `table({ sample: 20 })` is the
cheaper, exact first look.

## INFORMATION_SCHEMA

Each dataset has `INFORMATION_SCHEMA` views; they bill at least 10 MB and never use the cache
([Introduction to INFORMATION_SCHEMA](https://cloud.google.com/bigquery/docs/information-schema-intro)):

```sql
-- Tables in a dataset, with their sizes.
SELECT table_name, table_type, size_bytes, row_count
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.TABLES`
ORDER BY size_bytes DESC;

-- Columns with their types and policy tags.
SELECT column_name, data_type, policy_tags
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
WHERE table_name = 'shakespeare';

-- A table's partitions.
SELECT partition_id, total_rows, total_logical_bytes
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.PARTITIONS`
ORDER BY total_rows DESC;
```

`bigquery_search` and `bigquery_table` read these for you. A region- or project-qualified `INFORMATION_SCHEMA` reference
is refused while the account has an allow fence.

## Worked examples

Each of these reads Google's public data (`bigquery-public-data`) and bills at least the 10 MB minimum on the billing
project, so estimate first.

1. `SELECT word, SUM(word_count) AS n FROM bigquery-public-data.samples.shakespeare WHERE corpus = 'hamlet' GROUP BY word ORDER BY n DESC LIMIT 20`
2. `SELECT year, SUM(weight_pounds) AS pounds FROM bigquery-public-data.samples.natality WHERE year BETWEEN 1990 AND 2000 GROUP BY year ORDER BY year`
3. `SELECT name, SUM(number) AS n FROM bigquery-public-data.usa_names.usa_1910_current WHERE year = 2000 AND gender = 'F' GROUP BY name ORDER BY n DESC LIMIT 25`
4. `SELECT tag, COUNT(*) AS questions FROM bigquery-public-data.stackoverflow.posts_questions, UNNEST(SPLIT(tags, '|')) AS tag WHERE creation_date >= '2020-01-01' GROUP BY tag ORDER BY questions DESC LIMIT 20`
5. `SELECT start_station_name, COUNT(*) AS hires FROM bigquery-public-data.london_bicycles.cycle_hire WHERE EXTRACT(YEAR FROM start_date) = 2020 GROUP BY start_station_name ORDER BY hires DESC LIMIT 20`
6. `SELECT EXTRACT(YEAR FROM date) AS year, EXTRACT(MONTH FROM date) AS month, AVG(temp) AS temp FROM bigquery-public-data.noaa_gsod.gsod2020 GROUP BY year, month ORDER BY year, month`
7. `SELECT user_pseudo_id, event_name, event_timestamp FROM bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20201101 QUALIFY ROW_NUMBER() OVER (PARTITION BY user_pseudo_id ORDER BY event_timestamp DESC) = 1 LIMIT 100`
8. `SELECT COUNT(*) FROM (SELECT 1 FROM bigquery-public-data.samples.shakespeare TABLESAMPLE SYSTEM (1 PERCENT))`
9. `SELECT table_name, size_bytes FROM bigquery-public-data.crypto_bitcoin.INFORMATION_SCHEMA.TABLES ORDER BY size_bytes DESC LIMIT 20`
10. `SELECT name, SUM(number) AS n FROM bigquery-public-data.usa_names.usa_1910_current WHERE state = @state AND year = @year GROUP BY name ORDER BY n DESC LIMIT 10`, with `{ state: "WY", year: 2000 }`.

## What the plugin refuses before Google runs anything

Legacy SQL; a statement that is not a `SELECT` or `ASSERT`; an external effect (`ML.*`, `AI.*`, `EXTERNAL_QUERY`,
`OBJ.GET_ACCESS_URL`, a remote or Python routine); a temporary function; and a read the byte cap cannot bound, which
needs a plan instead. A query that touches a table with policy-tagged columns returns no rows inline: save it with
`bigquery_save`.
