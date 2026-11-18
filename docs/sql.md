# GoogleSQL

Unofficial plugin. Not affiliated with Google.

The plugin runs **GoogleSQL**, BigQuery's standard SQL, and refuses legacy SQL (`LEGACY_SQL_REFUSED`). The language
reference is Google's: [Query syntax](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax). This
page is the short version an agent or a person needs before writing a query, with the rules that save the most bytes.

## The five habits that keep a query cheap

1. **Filter on the partition column.** A filtered partitioned table's estimate is precise, and only the selected
   partitions are read ([Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables)).
2. **Name the columns you need.** `SELECT *` reads every column; `LIMIT` does not reduce what is read
   ([Best practices for costs](https://cloud.google.com/bigquery/docs/best-practices-costs)).
3. **Estimate first.** `bigquery_estimate` dry-runs for free and answers the bytes, the cost, the referenced objects and
   whether the byte cap bounds the query.
4. **Aggregate in BigQuery**, not in the model: `COUNT`, `SUM`, `APPROX_COUNT_DISTINCT` and `APPROX_QUANTILES` return
   one row instead of thousands.
5. **Save and chart** when the result is bigger than a screen: `bigquery_save` writes CSV, JSONL or Parquet for
   `charts`.

## Parameters

Pass values as parameters, never by pasting them into the SQL text ([Parameterized queries](https://cloud.google.com/bigquery/docs/parameterized-queries)):

```sql
SELECT word, SUM(word_count) AS n
FROM `bigquery-public-data.samples.shakespeare`
WHERE corpus = @corpus
GROUP BY word
ORDER BY n DESC
LIMIT 10
```

`bigquery_query({ sql, params: { corpus: "hamlet" } })` sends `@corpus` as a named parameter. Positional `?`
parameters take an array. Strings, booleans, integers, floats and arrays of them are inferred; a `STRUCT`, `NULL` or an
`INT64` beyond 2^53 needs the type named explicitly, so pass such values inside a `CAST`.

## Dates and partitions

A date-partitioned table reads only the partitions a filter names:

```sql
SELECT COUNT(*) AS events
FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*`
WHERE _TABLE_SUFFIX BETWEEN '20201101' AND '20201130'
  AND event_name = 'purchase'
```

A wildcard table is a **change** to this plugin's guards: it cannot see which tables a `_TABLE_SUFFIX` selection reads,
so the read needs a plan ([Querying wildcard tables](https://cloud.google.com/bigquery/docs/querying-wildcard-tables);
Known limits). Prefer one table, or the dataset's `INFORMATION_SCHEMA` view, for reads that should run inline.

A table with `requirePartitionFilter` refuses a query that filters no partition. Add the filter, or use the ingestion
time pseudo-column `_PARTITIONTIME` ([Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables)).

## QUALIFY: one row per group

`QUALIFY` filters the result of a window function, so a "latest row per key" needs no subquery
([Query syntax: QUALIFY](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax#qualify_clause)):

```sql
SELECT repo_name, commit AS latest_commit, author.date AS authored
FROM `bigquery-public-data.github_repos.commits`
WHERE author.date >= '2020-01-01'
QUALIFY ROW_NUMBER() OVER (PARTITION BY repo_name ORDER BY author.date DESC) = 1
LIMIT 100
```

## Arrays and UNNEST

Repeated fields are arrays; `UNNEST` turns one into rows ([Querying arrays](https://cloud.google.com/bigquery/docs/querying-arrays)):

```sql
SELECT event_name, param.key AS key, param.value.string_value AS value
FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20201101`,
     UNNEST(event_params) AS param
WHERE event_name = 'page_view'
LIMIT 20
```

`ARRAY_AGG(x IGNORE NULLS ORDER BY t LIMIT 10)` builds an array back, and `(SELECT AS STRUCT …)` nests a struct.

## SAFE functions

A `SAFE.` prefix turns an error into `NULL` for the row, instead of failing the query
([Functions and operators: SAFE](https://cloud.google.com/bigquery/docs/reference/standard-sql/functions-and-operators#safe_prefix)):

```sql
SELECT SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
       SAFE_CAST(payload AS INT64) AS n
FROM `bigquery-public-data.samples.shakespeare`
```

`SAFE_CAST`, `SAFE_DIVIDE` and `SAFE_OFFSET` are the common ones. `SAFE.` is also the prefix the plugin's lexer
recognises before an `AI.` or `ML.` call, which is an external effect.

## Approximate aggregates

Approximations are much cheaper on large tables and exact enough for a profile
([Approximate aggregate functions](https://cloud.google.com/bigquery/docs/reference/standard-sql/approximate_aggregate_functions)):

```sql
SELECT APPROX_COUNT_DISTINCT(word) AS words,
       APPROX_QUANTILES(word_count, 100)[OFFSET(50)] AS median_count
FROM `bigquery-public-data.samples.shakespeare`
```

`bigquery_profile` writes this kind of query for you over one table, with null counts, distinct estimates, min/max,
quantiles and the top 5 values.

## TABLESAMPLE

A sample costs less than the whole table ([Table sampling](https://cloud.google.com/bigquery/docs/table-sampling)):

```sql
SELECT word, word_count
FROM `bigquery-public-data.samples.shakespeare` TABLESAMPLE SYSTEM (1 PERCENT)
LIMIT 50
```

TABLESAMPLE does not combine with row-level security, so the plugin refuses a sample of a row-secured table
([Row-level security](https://cloud.google.com/bigquery/docs/row-level-security-intro)). `bigquery_table({ sample: 20 })`
is the cheaper, exact alternative for a first look.

## INFORMATION_SCHEMA

Metadata lives in each dataset's `INFORMATION_SCHEMA` views, billed at least 10 MB and never cached
([Introduction to INFORMATION_SCHEMA](https://cloud.google.com/bigquery/docs/information-schema-intro)):

```sql
-- The tables in one dataset, with their sizes.
SELECT table_name, table_type, size_bytes, row_count
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.TABLES`
ORDER BY size_bytes DESC;

-- The columns of one table, with their types and policy tags.
SELECT column_name, data_type, policy_tags
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
WHERE table_name = 'shakespeare';

-- A table's partitions, with rows and bytes each.
SELECT partition_id, total_rows, total_logical_bytes
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.PARTITIONS`
ORDER BY total_rows DESC;
```

`bigquery_search` reads these for you, and `bigquery_table({ partitions: true })` reads the third.

## Ten worked examples

All ten read Google's public datasets (`bigquery-public-data`); each bills at least the 10 MB minimum on your billing
project, so estimate first.

1. **Count words in a play.** `SELECT word, SUM(word_count) AS n FROM bigquery-public-data.samples.shakespeare WHERE corpus = 'hamlet' GROUP BY word ORDER BY n DESC LIMIT 20`
2. **Births by year.** `SELECT year, SUM(weight_pounds) AS pounds FROM bigquery-public-data.samples.natality WHERE year BETWEEN 1990 AND 2000 GROUP BY year ORDER BY year`
3. **Most common names.** `SELECT name, SUM(number) AS n FROM bigquery-public-data.usa_names.usa_1910_current WHERE year = 2000 AND gender = 'F' GROUP BY name ORDER BY n DESC LIMIT 25`
4. **Questions per tag.** `SELECT tag, COUNT(*) AS questions FROM bigquery-public-data.stackoverflow.posts_questions, UNNEST(SPLIT(tags, '|')) AS tag WHERE creation_date >= '2020-01-01' GROUP BY tag ORDER BY questions DESC LIMIT 20`
5. **Bike hires per station.** `SELECT start_station_name, COUNT(*) AS hires FROM bigquery-public-data.london_bicycles.cycle_hire WHERE EXTRACT(YEAR FROM start_date) = 2020 GROUP BY start_station_name ORDER BY hires DESC LIMIT 20`
6. **A monthly weather average.** `SELECT EXTRACT(YEAR FROM date) AS year, EXTRACT(MONTH FROM date) AS month, AVG(temp) AS temp FROM bigquery-public-data.noaa_gsod.gsod2020 GROUP BY year, month ORDER BY year, month`
7. **Latest event per user.** `SELECT user_pseudo_id, event_name, event_timestamp FROM bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20201101 QUALIFY ROW_NUMBER() OVER (PARTITION BY user_pseudo_id ORDER BY event_timestamp DESC) = 1 LIMIT 100`
8. **A 1 % sample with a count.** `SELECT COUNT(*) FROM (SELECT 1 FROM bigquery-public-data.samples.shakespeare TABLESAMPLE SYSTEM (1 PERCENT))`
9. **Tables by size in a dataset.** `SELECT table_name, size_bytes FROM bigquery-public-data.crypto_bitcoin.INFORMATION_SCHEMA.TABLES ORDER BY size_bytes DESC LIMIT 20`
10. **A parameterised lookup.** `SELECT name, SUM(number) AS n FROM bigquery-public-data.usa_names.usa_1910_current WHERE state = @state AND year = @year GROUP BY name ORDER BY n DESC LIMIT 10`, with `{ state: "WY", year: 2000 }`.

## What the plugin refuses before Google

The read path has its own rules on top of Google's parser: legacy SQL; a statement that is not a `SELECT` or `ASSERT`;
a statement with an external effect (`ML.*`, `AI.*`, `EXTERNAL_QUERY`, `OBJ.GET_ACCESS_URL`, a remote or Python
routine); temporary functions; and a read whose cost the byte cap cannot bound, which needs a plan instead. A query
that names a table with policy-tagged columns returns no rows inline: save it with `bigquery_save`.
