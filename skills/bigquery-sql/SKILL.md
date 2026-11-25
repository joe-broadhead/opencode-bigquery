---
name: bigquery-sql
description: GoogleSQL for BigQuery — partition filters, wildcards, QUALIFY, UNNEST, SAFE functions, approximate aggregates, TABLESAMPLE, INFORMATION_SCHEMA and query parameters.
---
If the `bigquery` tools are absent, sign in first: run `/connect` and choose the BigQuery account.

# GoogleSQL

The plugin runs GoogleSQL, BigQuery's standard SQL
([Query syntax](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax)). Legacy SQL is refused
(`LEGACY_SQL_REFUSED`). BigQuery bills the bytes a query **reads**, so these rules decide the cost before it runs; every
`sql` block here is a complete statement the plugin accepts.

1. **Filter the partition column.** A filtered partitioned table's estimate is precise and only those partitions are
   read ([Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables); [Best practices
   for costs](https://cloud.google.com/bigquery/docs/best-practices-costs)).
2. **Name the columns.** `SELECT *` reads every column, and `LIMIT` does not reduce the bytes read.
3. **Aggregate in BigQuery**, not in the model: `COUNT`, `SUM`, `APPROX_COUNT_DISTINCT`, `APPROX_QUANTILES`.
4. **Estimate first** with `estimate`; it is a free dry run.
5. **Save and chart** a large result with `save` instead of asking for thousands of rows.

## Parameters

Pass values as parameters, never pasted into the SQL text
([Parameterized queries](https://cloud.google.com/bigquery/docs/parameterized-queries)):

```sql
-- Run with params: { "corpus": "hamlet", "min": 10 }
SELECT word, SUM(word_count) AS n
FROM `bigquery-public-data.samples.shakespeare`
WHERE corpus = @corpus
GROUP BY word
HAVING n >= @min
ORDER BY n DESC
LIMIT 20
```

Positional parameters use `?` and an array.

## The shapes worth knowing

- **Partition filter.** `WHERE event_date = "2026-11-24"` or `WHERE event_date BETWEEN @from AND @to`. On a table that
  requires a filter, a query without one is refused by BigQuery.
- **Wildcard tables.** ``FROM `proj.ds.events_*` WHERE _TABLE_SUFFIX BETWEEN "20261101" AND "20261124"`` reads only the
  matching tables ([Wildcard tables](https://cloud.google.com/bigquery/docs/querying-wildcard-tables)).
- **`QUALIFY`** filters a window function's result without a subquery: `QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY at DESC) = 1`.
- **`UNNEST`** flattens an array: `FROM t, UNNEST(t.items) AS item`; `WITH OFFSET` numbers the elements.
- **`SAFE.` functions** return NULL instead of failing: `SAFE_CAST(x AS INT64)`, `SAFE_DIVIDE(a, b)`.
- **`APPROX_` aggregates** are cheaper on large tables: `APPROX_COUNT_DISTINCT`, `APPROX_QUANTILES(x, 100)`.
- **`TABLESAMPLE SYSTEM (n PERCENT)`** reads a sample; it cannot be combined with a row access policy.
- **`INFORMATION_SCHEMA`** names objects: `proj.ds.INFORMATION_SCHEMA.TABLES`, `.COLUMNS`, `.PARTITIONS`. A region- or
  project-level `INFORMATION_SCHEMA` view is refused under an allow fence; use `search` instead.
- **Scripts** (several statements) are allowed only through a plan, and need an explicit `maxBytes`; a script's
  estimate covers only its leading statements.
- **Views and routines** are expanded before a read: their bodies' tables are checked too. A temporary function sends
  the read to `plan_query`.

## What a read may not be

A read is SELECT or ASSERT. Anything that writes, exports, grants, defines or calls (`CREATE`, `INSERT`, `MERGE`,
`DELETE`, `DROP`, `GRANT`, `EXPORT DATA`, `CALL`, `BEGIN TRANSACTION`) belongs to a planner and a commit. A query with
`ML.` or `AI.` functions, an external query or a remote function bills outside the byte cap, so it needs `plan_query`
too: the dry run names the effect and the plugin refuses before any job starts.
