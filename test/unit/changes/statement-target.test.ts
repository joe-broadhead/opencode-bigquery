// The destination a statement's own leading keywords name (review bigquery-8 H-1): the server names no target for DML,
// ALTER, TRUNCATE, LOAD, CALL or CREATE MODEL, so this stricter-only reader supplies one for the fence and a person's
// rules. It reads the tokens after the leading keywords, never a FROM clause, and refuses anything it cannot name.
import { describe, expect, it } from "vitest"
import { statementSources, statementTarget } from "../../../src/changes/statement-target.js"

const at = (sql: string, type = "INSERT") => statementTarget(sql, type, "invented-proj")

const names = (sql: string, type = "INSERT") => {
  const target = at(sql, type)
  expect(target, sql).toBeDefined()
  return { kind: target!.kind, project: target!.project, dataset: target!.dataset, name: target!.name }
}

describe("the statement's own destination", () => {
  it("reads the DML forms", () => {
    expect(names("INSERT INTO `acme.sales.orders` (id) VALUES (1)")).toEqual({ kind: "table", project: "acme", dataset: "sales", name: "orders" })
    expect(names("INSERT INTO `p.sales.orders` SELECT 1")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("UPDATE `p.sales.orders` SET id = 2")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("DELETE FROM `p.sales.orders` WHERE id = 1", "DELETE")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("MERGE INTO `p.sales.orders` t USING `p.sales.other` s ON t.id = s.id", "MERGE")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("TRUNCATE TABLE `p.sales.orders`", "TRUNCATE_TABLE")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
  })

  it("reads a two-part path against the job's project, and drops a partition decorator", () => {
    expect(names("INSERT INTO sales.orders (id) VALUES (1)")).toEqual({ kind: "table", project: "invented-proj", dataset: "sales", name: "orders" })
    expect(names("INSERT INTO `p.sales.orders$20260101` (id) VALUES (1)")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
  })

  it("reads DDL, LOAD, CALL and GRANT destinations", () => {
    expect(names("ALTER TABLE `p.sales.orders` ADD COLUMN x INT64", "ALTER_TABLE")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("DROP TABLE `p.sales.orders`", "DROP_TABLE")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("LOAD DATA OVERWRITE INTO `p.sales.orders` FROM FILES (format = 'CSV', uris = ['gs://x/y.csv'])", "LOAD_DATA")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("CALL `p.sales.proc`(1)", "CALL")).toEqual({ kind: "routine", project: "p", dataset: "sales", name: "proc" })
    expect(names("CREATE OR REPLACE TABLE `p.sales.orders` (id INT64)", "CREATE_TABLE")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(names("CREATE SCHEMA `p.fresh`", "CREATE_SCHEMA")).toEqual({ kind: "dataset", project: "p", dataset: "fresh", name: "fresh" })
    expect(names("CREATE TABLE FUNCTION `p.sales.fn`() AS (SELECT 1)", "CREATE_TABLE_FUNCTION")).toEqual({ kind: "routine", project: "p", dataset: "sales", name: "fn" })
    expect(names("GRANT `roles/bigquery.dataViewer` ON TABLE `p.sales.orders` TO 'group:invented@example.invalid'", "GRANT_ON_TABLE")).toEqual({
      kind: "table",
      project: "p",
      dataset: "sales",
      name: "orders",
    })
  })

  it("takes the destination from the INSERT's own head, not from its FROM clause", () => {
    expect(names("INSERT INTO `p.sales.orders` (id) SELECT id FROM `x.hidden.secret`")).toEqual({ kind: "table", project: "p", dataset: "sales", name: "orders" })
  })

  it("reads an EXPORT MODEL or EXPORT TABLE METADATA source", () => {
    expect(at("EXPORT MODEL `p.sales.m` OPTIONS (uri = 'gs://invented/x')", "EXPORT_MODEL")).toMatchObject({ kind: "table", project: "p", dataset: "sales", name: "m" })
    expect(at("EXPORT TABLE METADATA FROM `p.sales.orders`", "EXPORT_METADATA")).toMatchObject({ kind: "table", project: "p", dataset: "sales", name: "orders" })
    expect(at("EXPORT DATA OPTIONS (uri = 'gs://invented/x.csv', format = 'CSV') AS SELECT 1", "EXPORT_DATA")).toBeUndefined()
  })

  it("reads a CLONE or COPY source, and only at parenthesis depth 0", () => {
    expect(statementSources("CREATE TABLE `p.sales.copy` CLONE `p.hr.people`", "CREATE_TABLE", "invented-proj")).toMatchObject({
      required: true,
      targets: [{ kind: "table", project: "p", dataset: "hr", name: "people" }],
    })
    expect(statementSources("CREATE SNAPSHOT TABLE `p.sales.snap` CLONE `p.hr.people`", "CREATE_SNAPSHOT_TABLE", "invented-proj")).toMatchObject({ required: true })
    expect(statementSources("CREATE TABLE `p.sales.copy2` COPY `p.hr.people`", "CREATE_TABLE", "invented-proj")).toMatchObject({ required: true })
    expect(statementSources("CREATE TABLE `p.sales.copy` (id INT64)", "CREATE_TABLE", "invented-proj")).toEqual({ targets: [], required: false })
    expect(statementSources("CREATE TABLE `p.sales.copy` (copy INT64)", "CREATE_TABLE", "invented-proj")).toEqual({ targets: [], required: false })
    expect(statementSources("CREATE TABLE `p.sales.copy` CLONE `s`", "CREATE_TABLE", "invented-proj")).toEqual({ targets: [], required: true })
  })

  it("refuses what it cannot name, so a fence fails closed", () => {
    for (const sql of [
      "SELECT * FROM `p.sales.orders`",
      "INSERT INTO t (id) VALUES (1)",
      "INSERT INTO `_SESSION.t` (id) VALUES (1)",
      "CREATE TEMP TABLE t (x INT64)",
      "CREATE SEARCH INDEX idx ON `p.sales.orders` (id)",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "EXPORT DATA OPTIONS (uri = 'gs://x/y.csv', format = 'CSV') AS SELECT 1",
    ]) {
      expect(at(sql), sql).toBeUndefined()
    }
  })
})
