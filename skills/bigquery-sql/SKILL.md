---
name: bigquery-sql
description: GoogleSQL for BigQuery - partition filters, wildcards, QUALIFY, UNNEST, SAFE functions, APPROX aggregates, TABLESAMPLE, INFORMATION_SCHEMA and query parameters, with worked examples.
---
If BigQuery's tools are absent, run `/connect` and choose BigQuery to sign in.

# GoogleSQL

The plugin runs GoogleSQL, BigQuery's standard SQL ([Query syntax](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax)).
Legacy SQL is refused (`LEGACY_SQL_REFUSED`). BigQuery bills the bytes a query **reads**, so these rules decide the cost
before the query runs; every `sql` block here is a complete statement the plugin accepts.

1. **Filter the partition column.** A filtered partitioned table's estimate is precise and only those partitions are
   read ([Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables); [Best practices
   for costs](https://cloud.google.com/bigquery/docs/best-practices-costs)).
2. **Name the columns.** `SELECT *` reads every column. `LIMIT` does not reduce the bytes read
   ([Best practices for costs](https://cloud.google.com/bigquery/docs/best-practices-costs)).
3. **Aggregate in BigQuery**, not in the model: `COUNT`, `SUM`, `APPROX_COUNT_DISTINCT`, `APPROX_QUANTILES`.
4. **Estimate first** with `bigquery_estimate`; it is a free dry run.
5. **Save and chart** a large result with `bigquery_save` instead of asking for thousands of rows.

## Parameters

Pass values as parameters, never pasted into the SQL text
([Parameterized queries](https://cloud.google.com/bigquery/docs/parameterized-queries)):

```sql
-- Run with params: { "corpus": "hamlet", "min": 10 }
SELECT word, SUM(word_count) AS n
FROM `bigquery-public-data.samples.shakespeare`
WHERE corpus = @corpus AND word_count > @min
GROUP BY word
ORDER BY n DESC
LIMIT 10
```

The input carries values only, so the type comes from the JavaScript value: strings, booleans, integers, floats and
arrays of them are inferred. A `STRUCT` cannot be built from values alone: pass its fields as scalar parameters and
build it in the SQL (`STRUCT(@a AS a, @b AS b)`), or pass JSON text and read it with
`JSON_VALUE(PARSE_JSON(@p), '$.a')`. A `null` has no type of its own, so write `CAST(NULL AS INT64)` in the SQL rather
than passing one. An integer above 2^53 loses precision as a JSON number: pass it as a string and `CAST(@id AS INT64)`
it. Positional `?` parameters take an array.

## Dates and partitions

```sql
-- Your own date-partitioned table: the DATE column `event_date` is its partition column.
SELECT COUNT(*) AS events
FROM `my-project.my_dataset.events`
WHERE event_date = DATE '2026-11-01'
```

```sql
-- An ingestion-time partitioned table, whose pseudo-column is `_PARTITIONTIME`.
SELECT COUNT(*) AS rows_loaded
FROM `my-project.my_dataset.events_ingested`
WHERE _PARTITIONTIME = TIMESTAMP '2026-11-01'
```

A `requirePartitionFilter` table refuses a query that filters no partition. Add its partition column's filter; on an
ingestion-time partitioned table, `_PARTITIONTIME` is that filter
([Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables)).

A **wildcard table** is a special case for this plugin's guards: nothing can tell which tables a `_TABLE_SUFFIX` selection
reads, so the read needs a plan ([Querying wildcard tables](https://cloud.google.com/bigquery/docs/querying-wildcard-tables)).
Prefer one table or an `INFORMATION_SCHEMA` view for a read that should run inline.

## QUALIFY

`QUALIFY` filters a window function's result, so "one row per group" needs no subquery
([QUALIFY](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax#qualify_clause)):

```sql
SELECT state, year, name, number
FROM `bigquery-public-data.usa_names.usa_1910_current`
WHERE year BETWEEN 1990 AND 2000 AND gender = 'F'
QUALIFY ROW_NUMBER() OVER (PARTITION BY state, year ORDER BY number DESC) = 1
ORDER BY state, year
LIMIT 51
```

A bare column named like a statement keyword (such as `commit`) makes the lexer refuse the `SELECT`; quote it
(`` `commit` ``) or rename it.

## UNNEST

`UNNEST` turns an array or a repeated field into rows ([Querying arrays](https://cloud.google.com/bigquery/docs/querying-arrays)):

```sql
SELECT event_name, param.key AS key, param.value.string_value AS value
FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20201101`,
     UNNEST(event_params) AS param
WHERE event_name = 'page_view'
LIMIT 20
```

`ARRAY_AGG(x IGNORE NULLS ORDER BY t LIMIT 10)` builds an array back, and `(SELECT AS STRUCT …)` nests a struct. A table
with policy-tagged columns makes the result save-only however the columns are named, because the dry run reports no
columns.

## SAFE functions

A `SAFE.` prefix turns an error into `NULL` for that row instead of failing the query
([SAFE](https://cloud.google.com/bigquery/docs/reference/standard-sql/functions-and-operators#safe_prefix)):

```sql
SELECT word, word_count,
       SAFE_DIVIDE(word_count, corpus_date) AS words_per_corpus_year,
       SAFE_CAST(corpus_date AS STRING) AS corpus_year
FROM `bigquery-public-data.samples.shakespeare`
WHERE corpus = 'hamlet'
ORDER BY word_count DESC
LIMIT 20
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
SELECT table_name, table_type
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.TABLES`
ORDER BY table_name
```

```sql
SELECT column_name, data_type, policy_tags
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
WHERE table_name = 'shakespeare'
```

```sql
SELECT partition_id, total_rows, total_logical_bytes
FROM `bigquery-public-data.samples.INFORMATION_SCHEMA.PARTITIONS`
ORDER BY total_rows DESC
```

The columns are each view's own: [TABLES](https://cloud.google.com/bigquery/docs/information-schema-tables),
[COLUMN_FIELD_PATHS](https://cloud.google.com/bigquery/docs/information-schema-column-field-paths) and
[PARTITIONS](https://cloud.google.com/bigquery/docs/information-schema-partitions); sizes and row counts are in
[TABLE_STORAGE](https://cloud.google.com/bigquery/docs/information-schema-table-storage), which is region-qualified.
`bigquery_search` and `bigquery_table` read these for you; `TABLES` has no size or row count, so use
`bigquery_list({ details: true })` or worked example 9. A region- or project-qualified `INFORMATION_SCHEMA` reference is
refused while the account has an allow fence.

## Worked examples

Nine read Google's public data ([BigQuery public datasets](https://cloud.google.com/bigquery/public-data));
the ninth reads your own project's. Each bills at least the 10 MB minimum on the billing project, so estimate first.

1. **Count words in a play.**

   ```sql
   SELECT word, SUM(word_count) AS n
   FROM `bigquery-public-data.samples.shakespeare`
   WHERE corpus = 'hamlet'
   GROUP BY word
   ORDER BY n DESC
   LIMIT 20
   ```

2. **Births by year.**

   ```sql
   SELECT year, SUM(number) AS births
   FROM `bigquery-public-data.usa_names.usa_1910_current`
   WHERE year BETWEEN 1990 AND 2000
   GROUP BY year
   ORDER BY year
   ```

3. **The most common female names in 2000.**

   ```sql
   SELECT name, SUM(number) AS n
   FROM `bigquery-public-data.usa_names.usa_1910_current`
   WHERE year = 2000 AND gender = 'F'
   GROUP BY name
   ORDER BY n DESC
   LIMIT 25
   ```

4. **The tags with the most questions.**

   ```sql
   SELECT tag_name, `count` AS questions
   FROM `bigquery-public-data.stackoverflow.tags`
   ORDER BY questions DESC
   LIMIT 20
   ```

5. **Bike hires per station in 2020.**

   ```sql
   SELECT start_station_name, COUNT(*) AS hires
   FROM `bigquery-public-data.london_bicycles.cycle_hire`
   WHERE EXTRACT(YEAR FROM start_date) = 2020
   GROUP BY start_station_name
   ORDER BY hires DESC
   LIMIT 20
   ```

6. **A monthly weather average.**

   ```sql
   SELECT EXTRACT(YEAR FROM date) AS year, EXTRACT(MONTH FROM date) AS month, AVG(temp) AS temp
   FROM `bigquery-public-data.noaa_gsod.gsod2020`
   GROUP BY year, month
   ORDER BY year, month
   ```

7. **The latest event per user.**

   ```sql
   SELECT user_pseudo_id, event_name, event_timestamp
   FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20201101`
   QUALIFY ROW_NUMBER() OVER (PARTITION BY user_pseudo_id ORDER BY event_timestamp DESC) = 1
   LIMIT 100
   ```

8. **A 1 % sample, counted.**

   ```sql
   SELECT COUNT(*) AS sampled_rows
   FROM (SELECT 1 FROM `bigquery-public-data.samples.shakespeare` TABLESAMPLE SYSTEM (1 PERCENT))
   ```

9. **Your own project's tables by size.** `TABLE_STORAGE` is region-qualified
   ([TABLE_STORAGE](https://cloud.google.com/bigquery/docs/information-schema-table-storage)). With no project before
   `region-us`, it reads your **billing project**, needs BigQuery Metadata Viewer on that project, and the plugin refuses
   a region-qualified reference while the account has an allow fence. For a public dataset's table sizes, use
   `bigquery_list({ project: "bigquery-public-data", dataset: "crypto_bitcoin", details: true })`, which reads the
   dataset's tables with `tables.get`.

   ```sql
   -- Reads the billing project (`region-us` with no project before it); BigQuery Metadata Viewer is needed on it.
   SELECT table_name, total_rows, total_logical_bytes, total_physical_bytes
   FROM `region-us`.INFORMATION_SCHEMA.TABLE_STORAGE
   WHERE table_schema = 'my_dataset'
   ORDER BY total_logical_bytes DESC
   LIMIT 20
   ```

10. **A lookup for one state and year.**

    ```sql
    SELECT name, SUM(number) AS n
    FROM `bigquery-public-data.usa_names.usa_1910_current`
    WHERE state = 'WY' AND year = 2000
    GROUP BY name
    ORDER BY n DESC
    LIMIT 10
    ```

## What the plugin refuses before Google runs anything

Legacy SQL; a statement that is not a `SELECT` or `ASSERT`; an external effect (`ML.*`, `AI.*`, `EXTERNAL_QUERY`,
`OBJ.GET_ACCESS_URL`, a remote or Python routine); a temporary function; and a read the byte cap cannot bound, which
needs a plan instead. A query that touches a table with policy-tagged columns returns no rows inline: save it with
`bigquery_save`.
