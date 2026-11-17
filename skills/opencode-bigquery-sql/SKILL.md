---
name: opencode-bigquery-sql
description: GoogleSQL for BigQuery - partition filters, wildcard tables, QUALIFY, UNNEST, SAFE functions, APPROX aggregates, TABLESAMPLE, INFORMATION_SCHEMA and query parameters, with worked examples.
---
If BigQuery's tools are absent, run `/connect` and choose BigQuery to sign in, or on Jelly call jelly_connection_request.

This skill is written as the tools are built. Until then:

- Filter on a table's partition column: BigQuery bills the bytes a query reads, and `LIMIT` does not reduce them.
- Name the columns you need instead of `SELECT *`.
- Pass values as query parameters, never by pasting them into the SQL text.
