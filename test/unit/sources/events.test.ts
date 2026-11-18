// The `bigquery.jobs` source (design §10), and the three bugs every source review finds: the sliding gap, the jam, and
// a gap repeated once per read. Each is a test here, against the strict `jobs.list` stand-in — no BigQuery call.
import { describe, expect, test } from "vitest"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { bindingOf } from "../../../src/sources/cursor.js"
import { harness, runTool, serveJobs, type JobFixture } from "./support.js"

const NOW = Date.parse("2026-11-17T12:00:00Z")
const HOUR = 3_600_000
const DAY = 86_400_000
const MIN = 60_000

const job = (fields: Partial<JobFixture> & { readonly jobId: string; readonly created: number; readonly ended: number }): JobFixture => ({
  statementType: "SELECT",
  bytesBilled: 1_048_576,
  ...fields,
})

const ids = (page: Record<string, unknown>) => ((page["events"] as { external_id: string }[] | undefined) ?? []).map((event) => event.external_id)
const times = (page: Record<string, unknown>) => ((page["events"] as { occurred_at: string }[] | undefined) ?? []).map((event) => Date.parse(event.occurred_at))

/** One page of the events source, through the registry as the model's tool calls it. */
async function page(target: ReturnType<typeof harness>, input: Record<string, unknown>, via: "tool" | "rpc" = "tool") {
  return (await runTool(target, "events_list", { source: "jobs", ...input }, { via })).output
}

/** Every page until `more` is false, and every id in them. */
async function drain(target: ReturnType<typeof harness>, input: Record<string, unknown>, limit = 100) {
  const collected: string[] = []
  const pages: Record<string, unknown>[] = []
  let cursor = input["cursor"] as string | undefined
  for (let round = 0; round < 400; round++) {
    const answer = await page(target, { ...input, ...(cursor !== undefined ? { cursor } : {}), limit })
    pages.push(answer)
    collected.push(...ids(answer))
    cursor = answer["cursor"] as string
    if (answer["more"] !== true) break
  }
  return { collected, pages, cursor }
}

describe("bigquery.jobs", () => {
  test("pages oldest first, ends with more: false, and then answers an empty page", async () => {
    const target = harness()
    serveJobs(target.bigquery, [
      job({ jobId: "j1", created: NOW - 3 * HOUR, ended: NOW - 3 * HOUR + MIN }),
      job({ jobId: "j2", created: NOW - 2 * HOUR, ended: NOW - HOUR }),
      job({ jobId: "j3", created: NOW - HOUR, ended: NOW - 30 * MIN }),
    ])
    const since = new Date(NOW - 4 * HOUR).toISOString()
    const first = await page(target, { since, limit: 1 })
    expect(first["more"]).toBe(true)
    expect(ids(first)).toEqual([`invented-proj:US:j1`])
    const second = await page(target, { cursor: first["cursor"], limit: 1 })
    expect(ids(second)).toEqual([`invented-proj:US:j2`])
    const third = await page(target, { cursor: second["cursor"], limit: 1 })
    expect(ids(third)).toEqual([`invented-proj:US:j3`])
    expect(third["more"]).toBe(false)
    // The chain is complete: its cursor starts a lookback, which finds nothing new and repeats nothing.
    const empty = await page(target, { cursor: third["cursor"] })
    expect(empty["events"]).toEqual([])
    expect(empty["more"]).toBe(false)
    for (const answer of [first, second, third]) {
      const order = times(answer)
      expect(order).toEqual([...order].sort((left, right) => left - right))
    }
  })

  test("a job still running at the first read is delivered once it finishes, and the lookback repeats nothing", async () => {
    const target = harness()
    const jobs: JobFixture[] = [
      job({ jobId: "done", created: NOW - 2 * HOUR, ended: NOW - 90 * MIN }),
      job({ jobId: "late", created: NOW - 90 * MIN, ended: NOW, state: "RUNNING" }),
    ]
    serveJobs(target.bigquery, jobs)
    const first = await page(target, { since: new Date(NOW - 4 * HOUR).toISOString() })
    expect(ids(first)).toEqual(["invented-proj:US:done"])
    // Ten minutes later the job has finished; its end is after the first read's window end.
    target.clock.advance(10 * MIN)
    const finished: JobFixture[] = [
      job({ jobId: "done", created: NOW - 2 * HOUR, ended: NOW - 90 * MIN }),
      job({ jobId: "late", created: NOW - 90 * MIN, ended: NOW + 5 * MIN, state: "DONE" }),
    ]
    serveJobs(target.bigquery, finished)
    const second = await page(target, { cursor: first["cursor"] })
    expect(ids(second)).toEqual(["invented-proj:US:late"])
    const third = await page(target, { cursor: second["cursor"] })
    expect(third["events"]).toEqual([])
  })

  test("the sliding gap: a truncated window carries the older part's floor and reads it next, never from now", async () => {
    const target = harness()
    // 12 jobs, one provider page per call: ten calls can only fetch the newest ten, so the window is truncated.
    const jobs = Array.from({ length: 12 }, (_, index) =>
      job({ jobId: `j${String(index + 1).padStart(2, "0")}`, created: NOW - (12 - index) * HOUR, ended: NOW - (12 - index) * HOUR + 5 * MIN }),
    )
    serveJobs(target.bigquery, jobs, { pageSize: 1 })
    const since = new Date(NOW - 24 * HOUR).toISOString()
    const first = await page(target, { since })
    expect(first["more"]).toBe(true)
    expect(first["gap"]).toBeUndefined()
    // The delivered part is the newer one; the older part is owed, and the next page reads it.
    const { collected, pages } = await drain(target, { since })
    expect(new Set(collected).size).toBe(12)
    expect(collected.length).toBe(12)
    // The job at the truncation line (j03, created 10 hours ago) was not skipped: it is on the continuation page.
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.flatMap(ids)).toContain("invented-proj:US:j03")
    expect(pages.at(-1)!["more"]).toBe(false)
  })

  test("a truncated window cut by the page limit carries both the position and the older part's floor", async () => {
    // One provider page per call and more than ten pages of jobs: the window narrows, the newer part is cut by limit,
    // and the older part must still be read next. Every job is delivered once, across windows.
    const jobs = Array.from({ length: 1_050 }, (_, index) =>
      job({ jobId: `w-${String(index).padStart(4, "0")}`, created: NOW - 24 * HOUR + index * 60_000, ended: NOW - 24 * HOUR + index * 60_000 + 30_000 }),
    )
    const target = harness()
    serveJobs(target.bigquery, jobs, { pageSize: 1 })
    const { collected, pages } = await drain(target, { since: new Date(NOW - 24 * HOUR).toISOString() }, 5)
    expect(new Set(collected).size).toBe(1_050)
    expect(collected.length).toBe(1_050)
    expect(pages.at(-1)!["gap"]).toBeUndefined()
    // The chain drained a backlog down to an older window; its top, not that window's end, is the high-water mark, so
    // the lookback after it repeats none of the newer part it already listed. It still walks the rest of the lookback
    // (nothing there is finished after the mark), and every page of that walk is empty.
    let after = await page(target, { cursor: pages.at(-1)!["cursor"] })
    expect(after["events"]).toEqual([])
    for (let round = 0; round < 400 && after["more"] === true; round++) {
      after = await page(target, { cursor: after["cursor"] })
      expect(after["events"]).toEqual([])
    }
    expect(after["more"]).toBe(false)
  })

  test("the jam: 200 jobs ending in one millisecond drain once each through the position in the cursor", async () => {
    const at = NOW - HOUR
    const jobs = Array.from({ length: 200 }, (_, index) => job({ jobId: `burst-${String(index).padStart(3, "0")}`, created: NOW - 2 * HOUR + index, ended: at }))
    const target = harness()
    serveJobs(target.bigquery, jobs)
    const { collected } = await drain(target, { since: new Date(NOW - 4 * HOUR).toISOString() }, 50)
    expect(collected.length).toBe(200)
    expect(new Set(collected).size).toBe(200)
  })

  test("a burst larger than a page keeps its oldest-first order", async () => {
    const jobs = Array.from({ length: 120 }, (_, index) => job({ jobId: `b-${String(index).padStart(3, "0")}`, created: NOW - 3 * HOUR + index, ended: NOW - HOUR + index * 100 }))
    const target = harness()
    serveJobs(target.bigquery, jobs)
    const { pages } = await drain(target, { since: new Date(NOW - 4 * HOUR).toISOString() }, 20)
    for (const answer of pages) {
      const order = times(answer)
      expect(order).toEqual([...order].sort((left, right) => left - right))
    }
  })

  test("a gap is announced once: an expired cursor gaps, and the cursor it answers with does not gap again", async () => {
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: NOW - HOUR, ended: NOW - 30 * MIN })])
    const expired = encodeBoundCursor(bindingOf("default", undefined), { w: NOW - 181 * DAY, f: NOW - 182 * DAY, e: NOW - 181 * DAY })
    const first = await page(target, { cursor: expired })
    expect(first["gap"]).toEqual({ reason: "expired", since: new Date(NOW - 181 * DAY).toISOString() })
    expect(first["more"]).toBe(false)
    const second = await page(target, { cursor: first["cursor"] })
    expect(second["gap"]).toBeUndefined()
    const third = await page(target, { cursor: second["cursor"] })
    expect(third["gap"]).toBeUndefined()
  })

  test("a secret-shaped title is refused, with its reason, and never listed", async () => {
    const target = harness()
    serveJobs(target.bigquery, [
      job({ jobId: "ok", created: NOW - 2 * HOUR, ended: NOW - 90 * MIN }),
      job({ jobId: "secret", created: NOW - HOUR, ended: NOW - 30 * MIN, statementType: "deploy ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }),
    ])
    const answer = await page(target, { since: new Date(NOW - 4 * HOUR).toISOString() })
    expect(ids(answer)).toEqual(["invented-proj:US:ok"])
    expect(answer["refused"]).toEqual([expect.objectContaining({ external_id: "invented-proj:US:secret", reason: "secret" })])
  })

  test("the cursor is bound to its source, account and scope, and another binding's is CURSOR_INVALID", async () => {
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: NOW - HOUR, ended: NOW - 30 * MIN })])
    const scoped = await page(target, { since: new Date(NOW - 2 * HOUR).toISOString(), scope: { projects: ["invented-proj"] } })
    // The same cursor without the confirmed scope is another binding's.
    const unscoped = await runTool(target, "events_list", { source: "jobs", cursor: scoped["cursor"] })
    expect(unscoped.output["error"]).toBe("CURSOR_INVALID")
    const otherAccount = encodeBoundCursor(bindingOf("other", undefined), { w: NOW, f: NOW - HOUR, e: NOW })
    expect((await runTool(target, "events_list", { source: "jobs", cursor: otherAccount })).output["error"]).toBe("CURSOR_INVALID")
    const otherPlugin = encodeBoundCursor({ plugin: "another-plugin", source: "jobs", account: "default" }, { w: NOW, f: NOW - HOUR, e: NOW })
    expect((await runTool(target, "events_list", { source: "jobs", cursor: otherPlugin })).output["error"]).toBe("CURSOR_INVALID")
    // The scoped cursor is this binding's, and reads the scope's pages.
    const again = await page(target, { cursor: scoped["cursor"], scope: { projects: ["invented-proj"] } })
    expect(again["events"]).toEqual([])
  })

  test("an events page names its owner, its source and its account, and carries a scope when one is confirmed", async () => {
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: NOW - HOUR, ended: NOW - 30 * MIN })])
    const answer = await page(target, { since: new Date(NOW - 2 * HOUR).toISOString(), scope: { projects: ["invented-proj"] } })
    expect(answer["source"]).toBe("jobs")
    expect(answer["account"]).toBe("default")
    expect(answer["owner"]).toEqual({ id: "mailto:ada@example.invalid", label: "ada@example.invalid" })
    expect(answer["trust"]).toBe("untrusted")
    expect(answer["scope"]).toEqual({ projects: ["invented-proj"] })
  })

  test("a script's call throws the contract's error, and the model's call answers the envelope", async () => {
    const target = harness()
    serveJobs(target.bigquery, [])
    const expired = encodeBoundCursor(bindingOf("default", undefined), { w: NOW - 400 * DAY, f: NOW - 401 * DAY, e: NOW - 400 * DAY })
    const model = await page(target, { cursor: expired })
    expect(model["gap"]).toMatchObject({ reason: "expired" })
    const script = await runTool(target, "events_list", { source: "jobs", cursor: "not-a-cursor" }, { via: "rpc" }).catch((error: unknown) => error)
    expect(String(script)).toContain("CURSOR_INVALID")
  })

  test("an account this plugin does not have is refused before any call", async () => {
    const target = harness()
    const answer = await runTool(target, "events_list", { source: "jobs", account: "other" })
    expect(answer.output["error"]).toBe("ACCOUNT_UNKNOWN")
    expect(target.bigquery.calls.filter((entry) => entry.method === "listJobs")).toEqual([])
  })
})
