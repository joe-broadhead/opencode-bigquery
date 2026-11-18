// `bigquery_save` (design §7, L11): CSV, JSONL and Parquet files written from a finished job's result table, with the
// path rules, the limits, the fence and the expired-result cases. The files are read back by this repository's own
// readers — the CSV and JSONL by plain parsing, Parquet by test/unit/files/parquet-read.ts — and nothing leaves the
// machine.
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import type { JobStatus, ResultPage } from "../../../src/ports.js"
import { jobStatus, harness, resultPage, runTool, PROJECT, LOCATION, type Harness } from "../sources/support.js"
import { readParquet } from "./parquet-read.js"

const roots: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "bq-save-"))
  roots.push(path)
  return path
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const JOB = "job_0001"

/** A harness whose results folder is `dir`, and a job that is DONE. */
function saved(dir: string, extra: Record<string, unknown> = {}, status: Partial<JobStatus> = {}): Harness {
  const target = harness({ resultsDir: dir, ...extra })
  target.bigquery.on("getJob", async () => jobStatus({ ref: { projectId: PROJECT, jobId: JOB, location: LOCATION }, ...status }))
  return target
}

const input = (path: string, format: "csv" | "jsonl" | "parquet", extra: Record<string, unknown> = {}) => ({ project: PROJECT, jobId: JOB, location: LOCATION, path, format, ...extra })

const schema = [
  { name: "id", type: "INT64" },
  { name: "amount", type: "FLOAT64" },
  { name: "note", type: "STRING" },
]
const page = (overrides: Partial<ResultPage> = {}): ResultPage =>
  resultPage({
    schema,
    rows: [
      { f: [{ v: "1" }, { v: "2.5" }, { v: "has,comma" }] },
      { f: [{ v: "2" }, { v: null }, { v: "plain" }] },
    ],
    totalRows: 2,
    ...overrides,
  })

describe("bigquery_save", () => {
  test("writes CSV, answers the file's rows, bytes and sha256, and asks for edit and external_directory", async () => {
    const dir = directory()
    const target = saved(dir)
    target.bigquery.on("results", async () => page())
    const { output, asserted } = await runTool(target, "save", input(join(dir, "orders.csv"), "csv"))
    expect(output).toMatchObject({ state: "done", path: join(dir, "orders.csv"), rows: 2, charts: { format: "csv", rows: 2, fitsCharts: true } })
    const text = readFileSync(join(dir, "orders.csv"), "utf8")
    expect(text).toBe(`id,amount,note\r\n1,2.5,"has,comma"\r\n2,,plain\r\n`)
    expect(output["bytes"]).toBe(Buffer.byteLength(text))
    expect(output["sha256"]).toBe(createHash("sha256").update(text).digest("hex"))
    expect(asserted[0]).toMatchObject({ action: "bigquery.save", resources: [`${"default"}:bigquery.jobs.getQueryResults`] })
    expect(asserted.map((request) => request.action)).toContain("edit")
    expect(asserted.map((request) => request.action)).toContain("external_directory")
    expect(target.bigquery.calls.filter((entry) => entry.method === "results").map((entry) => entry.args[2])).toEqual([{ timeoutMs: 0, maxResults: 10_000 }])
  })

  test("writes JSONL with nested values as JSON, and a repeated column name suffixed", async () => {
    const dir = directory()
    const target = saved(dir)
    target.bigquery.on("results", async () =>
      resultPage({
        schema: [
          { name: "id", type: "INT64" },
          { name: "who", type: "RECORD", fields: [{ name: "name", type: "STRING" }] },
          { name: "tags", type: "INT64", mode: "REPEATED" },
          { name: "id", type: "INT64" },
        ],
        rows: [{ f: [{ v: "1" }, { v: { f: [{ v: "ada" }] } }, { v: [{ v: "7" }, { v: "8" }] }, { v: "9" }] }],
        totalRows: 1,
      }),
    )
    const { output } = await runTool(target, "save", input(join(dir, "orders.jsonl"), "jsonl"))
    expect(output["rows"]).toBe(1)
    expect(readFileSync(join(dir, "orders.jsonl"), "utf8")).toBe(`${JSON.stringify({ id: 1, who: { name: "ada" }, tags: [7, 8], id_2: 9 })}\n`)
  })

  test("writes Parquet that another reader reads back with the same values", async () => {
    const dir = directory()
    const target = saved(dir)
    target.bigquery.on("results", async () => page())
    const file = join(dir, "orders.parquet")
    const { output } = await runTool(target, "save", input(file, "parquet"))
    expect(output).toMatchObject({ state: "done", rows: 2 })
    const parsed = readParquet(readFileSync(file))
    expect(parsed.rows).toBe(2)
    expect(parsed.columns.map((column) => column.name)).toEqual(["id", "amount", "note"])
    expect(parsed.columns[0]!.values).toEqual([
      { null: false, value: 1 },
      { null: false, value: 2 },
    ])
    expect(parsed.columns[1]!.values).toEqual([
      { null: false, value: 2.5 },
      { null: true },
    ])
    expect(parsed.columns[2]!.values).toEqual([
      { null: false, value: "has,comma" },
      { null: false, value: "plain" },
    ])
  })

  test("pages through getQueryResults and concatenates the rows", async () => {
    const dir = directory()
    const target = saved(dir)
    let call = 0
    target.bigquery.on("results", async (_account: string, _ref: unknown, request: { pageToken?: string }) => {
      call += 1
      if (request.pageToken === undefined) return page({ rows: [{ f: [{ v: "1" }, { v: "1" }, { v: "a" }] }], totalRows: 3, pageToken: "p2" })
      if (request.pageToken === "p2") return page({ rows: [{ f: [{ v: "2" }, { v: "2" }, { v: "b" }] }], totalRows: 3, pageToken: "p3" })
      return page({ rows: [{ f: [{ v: "3" }, { v: "3" }, { v: "c" }] }], totalRows: 3 })
    })
    const { output } = await runTool(target, "save", input(join(dir, "paged.csv"), "csv"))
    expect(output["rows"]).toBe(3)
    expect(call).toBe(3)
    expect(readFileSync(join(dir, "paged.csv"), "utf8")).toBe("id,amount,note\r\n1,1,a\r\n2,2,b\r\n3,3,c\r\n")
  })

  test("an existing file is SAVE_EXISTS unless overwrite is true", async () => {
    const dir = directory()
    writeFileSync(join(dir, "orders.csv"), "old")
    const target = saved(dir)
    const refused = await runTool(target, "save", input(join(dir, "orders.csv"), "csv"))
    expect(refused.output["error"]).toBe("SAVE_EXISTS")
    expect(target.bigquery.calls).toEqual([])
    target.bigquery.on("results", async () => page())
    const written = await runTool(target, "save", input(join(dir, "orders.csv"), "csv", { overwrite: true }))
    expect(written.output["state"]).toBe("done")
    expect(readFileSync(join(dir, "orders.csv"), "utf8")).toContain("has,comma")
  })

  test("a path outside the roots, or through a symbolic link, is SAVE_PATH_REFUSED", async () => {
    const dir = directory()
    const target = saved(dir)
    const outside = join(directory(), "escape.csv")
    const refused = await runTool(target, "save", input(outside, "csv"))
    expect(refused.output["error"]).toBe("SAVE_PATH_REFUSED")
    const link = join(dir, "link.csv")
    symlinkSync(outside, link)
    const linked = await runTool(target, "save", input(link, "csv"))
    expect(linked.output["error"]).toBe("SAVE_PATH_REFUSED")
    expect(target.bigquery.calls).toEqual([])
  })

  test("a result over maxSaveRows or maxSaveBytes is SAVE_LIMIT, and the partial file is gone", async () => {
    const dir = directory()
    const rows = saved(dir, { maxSaveRows: 1 })
    rows.bigquery.on("results", async () => page())
    const tooMany = await runTool(rows, "save", input(join(dir, "rows.csv"), "csv"))
    expect(tooMany.output["error"]).toBe("SAVE_LIMIT")
    expect(existsSync(join(dir, "rows.csv"))).toBe(false)
    expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([])

    const bytes = saved(dir, { maxSaveBytes: 10 })
    bytes.bigquery.on("results", async () => page())
    const tooBig = await runTool(bytes, "save", input(join(dir, "bytes.csv"), "csv"))
    expect(tooBig.output["error"]).toBe("SAVE_LIMIT")
    expect(existsSync(join(dir, "bytes.csv"))).toBe(false)
  })

  test("a missing result table is RESULTS_EXPIRED, at the job and at the first page", async () => {
    const dir = directory()
    const gone = saved(dir)
    const { BigQueryError } = await import("../../../src/domain/errors.js")
    gone.bigquery.on("getJob", async () => {
      throw new BigQueryError("NOT_FOUND", "The job was not found")
    })
    const atJob = await runTool(gone, "save", input(join(dir, "a.csv"), "csv"))
    expect(atJob.output["error"]).toBe("RESULTS_EXPIRED")

    const expired = saved(dir)
    expired.bigquery.on("results", async () => {
      throw new BigQueryError("NOT_FOUND", "The result table was not found")
    })
    const atPage = await runTool(expired, "save", input(join(dir, "b.csv"), "csv"))
    expect(atPage.output["error"]).toBe("RESULTS_EXPIRED")
    expect(existsSync(join(dir, "b.csv"))).toBe(false)
  })

  test("a job that is not finished yet answers running, with the tool that waits for it", async () => {
    const dir = directory()
    const target = saved(dir, {}, { state: "RUNNING", statementType: undefined })
    const { output } = await runTool(target, "save", input(join(dir, "later.csv"), "csv"))
    expect(output["state"]).toBe("running")
    expect(String(output["next"])).toContain("bigquery_job")
    expect(target.bigquery.calls.filter((entry) => entry.method === "results")).toEqual([])
  })

  test("a failed job is JOB_FAILED with Google's text apart, in googleError", async () => {
    const dir = directory()
    const target = saved(dir, {}, { error: { reason: "invalidQuery", message: "Syntax error: unexpected end of script" } })
    const { output } = await runTool(target, "save", input(join(dir, "failed.csv"), "csv"))
    expect(output["error"]).toBe("SQL_INVALID")
    expect(output["googleError"]).toMatchObject({ reason: "invalidQuery", trust: "untrusted" })
    expect(String(output["message"])).not.toContain("unexpected end of script")
  })

  test("the fence refuses a job over a fenced dataset, and one that names nothing under a fence", async () => {
    const dir = directory()
    const fenced = saved(dir, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { deny: ["invented-proj.hr"] } } } }, {
      referencedTables: [{ projectId: PROJECT, datasetId: "hr", tableId: "salaries" }],
    })
    const refused = await runTool(fenced, "save", input(join(dir, "fenced.csv"), "csv"))
    expect(refused.output["error"]).toBe("DATASET_FENCED")

    const cache = saved(dir, { accounts: { default: { billingProject: PROJECT, location: LOCATION, datasets: { deny: ["invented-proj.hr"] } } } }, { cacheHit: true, referencedTables: undefined })
    const blind = await runTool(cache, "save", input(join(dir, "blind.csv"), "csv"))
    expect(blind.output["error"]).toBe("DATASET_FENCED")
  })

  test("a save never reads a result before its own action and the file permission are allowed", async () => {
    const dir = directory()
    const target = saved(dir)
    target.bigquery.on("results", async () => page())
    const denied = await runTool(target, "save", input(join(dir, "denied.csv"), "csv"), {
      deny: (request) => request.action === "bigquery.save",
    }).catch((error: unknown) => error)
    expect(String(denied)).toContain("denied by the rules")
    expect(target.bigquery.calls).toEqual([])
    expect(existsSync(join(dir, "denied.csv"))).toBe(false)
  })
})
