// The `bigquery.jobs` source (design §10) one behaviour at a time: the contract's page, the read's range on Google's
// clock, the floor kept below running jobs, the three bugs every source review finds (the sliding gap, the jam, a gap
// repeated within a read), the cursor's binding and bounds, the per-operation assert, and unreachable locations.
// ./load.test.ts runs the same source at realistic load. No BigQuery call: the stand-ins are ./support.ts and ./sim.ts.
import { describe, expect, test } from "vitest"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { bindingOf } from "../../../src/sources/cursor.js"
import { SETTLE_MS } from "../../../src/sources/events.js"
import { harness, runTool, serveJobs, type JobFixture } from "./support.js"
import { DAY, HOUR, MIN, newReading, readOnce, Sim, type SimJob } from "./sim.js"

const NOW = Date.parse("2026-11-17T12:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()

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
  for (let round = 0; round < 2_000; round++) {
    const answer = await page(target, { ...input, ...(cursor !== undefined ? { cursor } : {}), limit })
    pages.push(answer)
    collected.push(...ids(answer))
    cursor = answer["cursor"] as string
    if (answer["more"] !== true) break
  }
  return { collected, pages, cursor }
}

describe("bigquery.jobs", () => {
  test("pages hold their events oldest first, a read ends with more: false, and the next read repeats nothing", async () => {
    const target = harness()
    serveJobs(target.bigquery, [
      job({ jobId: "j1", created: NOW - 3 * HOUR, ended: NOW - 3 * HOUR + MIN }),
      job({ jobId: "j2", created: NOW - 2 * HOUR, ended: NOW - HOUR }),
      job({ jobId: "j3", created: NOW - HOUR, ended: NOW - 30 * MIN }),
    ])
    const since = iso(NOW - 4 * HOUR)
    const all = await page(target, { since })
    expect(ids(all)).toEqual(["invented-proj:US:j1", "invented-proj:US:j2", "invented-proj:US:j3"])
    expect(times(all)).toEqual([...times(all)].sort((left, right) => left - right))
    expect(all["more"]).toBe(false)
    // Read again with limit 1: each page holds one, and the read ends after the third.
    const { collected, pages } = await drain(target, { since }, 1)
    expect([...collected].sort()).toEqual(["invented-proj:US:j1", "invented-proj:US:j2", "invented-proj:US:j3"])
    expect(pages.at(-1)!["more"]).toBe(false)
    const again = await page(target, { cursor: all["cursor"] })
    expect(again["events"]).toEqual([])
    expect(again["more"]).toBe(false)
  })

  test("a read delivers what ended up to Google's now less the settle margin; what ends later is the next read's", async () => {
    const target = harness()
    const jobs: SimJob[] = [
      { jobId: "settled", created: NOW - 10 * MIN, ended: NOW - SETTLE_MS - 1_000 },
      { jobId: "settling", created: NOW - 10 * MIN, ended: NOW - 30_000 },
    ]
    const sim = new Sim(target, jobs)
    const reading = newReading()
    target.clock.time = NOW
    await readOnce(sim, target, reading, { since: NOW - HOUR })
    expect([...reading.delivered.keys()]).toEqual(["settled"])
    target.clock.time = NOW + 5 * MIN
    await readOnce(sim, target, reading, {})
    expect([...reading.delivered.keys()].sort()).toEqual(["settled", "settling"])
    expect([...reading.delivered.values()]).toEqual([1, 1])
  })

  test("a job queued then running for hours keeps the floor below it, and is delivered once when it finishes", async () => {
    const target = harness()
    const long: SimJob = { jobId: "long", created: NOW + 5 * MIN, started: NOW + 2 * HOUR, ended: NOW + 7 * HOUR }
    const short: SimJob[] = Array.from({ length: 40 }, (_, index) => ({ jobId: `s${index}`, created: NOW + index * 10 * MIN, ended: NOW + index * 10 * MIN + MIN }))
    const sim = new Sim(target, [long, ...short])
    const reading = newReading()
    target.clock.time = NOW
    await readOnce(sim, target, reading, { since: NOW - HOUR })
    for (let hour = 1; hour <= 9; hour++) {
      target.clock.time = NOW + hour * HOUR
      await readOnce(sim, target, reading, {})
    }
    expect(reading.delivered.get("long")).toBe(1)
    expect(reading.delivered.size).toBe(41)
    expect([...reading.delivered.values()].every((count) => count === 1)).toBe(true)
    expect(reading.gaps).toEqual([])
  })

  test("the sliding gap: after an expired gap, a job ending minutes later is listed, never skipped by a line from now", async () => {
    const target = harness()
    const jobs: SimJob[] = [
      { jobId: "before", created: NOW - 20 * MIN, ended: NOW - 10 * MIN },
      { jobId: "after", created: NOW + MIN, ended: NOW + 4 * MIN },
      { jobId: "later", created: NOW + 2 * HOUR, ended: NOW + 2 * HOUR + MIN },
    ]
    const sim = new Sim(target, jobs)
    const expired = encodeBoundCursor(bindingOf("default", undefined), { e: NOW - 190 * DAY, f: NOW - 191 * DAY })
    const reading = newReading()
    reading.cursor = expired
    target.clock.time = NOW
    await readOnce(sim, target, reading, { limit: 1 })
    expect(reading.gaps).toEqual([{ at: NOW, reason: "expired", since: iso(NOW - 190 * DAY) }])
    for (const at of [NOW + 5 * MIN, NOW + 10 * MIN, NOW + 3 * HOUR]) {
      target.clock.time = at
      await readOnce(sim, target, reading, { limit: 1 })
    }
    expect([...reading.delivered.keys()].sort()).toEqual(["after", "before", "later"])
    expect(reading.gaps).toHaveLength(1)
  })

  test("a gap is answered once per read, across many small pages, and the cursor it answers with does not gap again", async () => {
    const target = harness()
    serveJobs(
      target.bigquery,
      Array.from({ length: 12 }, (_, index) => job({ jobId: `j${index}`, created: NOW - 5 * HOUR + index * MIN, ended: NOW - 4 * HOUR + index * MIN })),
    )
    const expired = encodeBoundCursor(bindingOf("default", undefined), { e: NOW - 181 * DAY, f: NOW - 182 * DAY })
    const { pages, collected } = await drain(target, { cursor: expired }, 1)
    expect(pages.filter((answer) => answer["gap"] !== undefined)).toHaveLength(1)
    expect(pages[0]!["gap"]).toEqual({ reason: "expired", since: iso(NOW - 181 * DAY) })
    expect(collected).toHaveLength(12)
    const next = await page(target, { cursor: pages.at(-1)!["cursor"] })
    expect(next["gap"]).toBeUndefined()
  })

  test("the jam: 200 jobs ending in one millisecond drain once each with limit 7", async () => {
    const target = harness()
    serveJobs(
      target.bigquery,
      Array.from({ length: 200 }, (_, index) => job({ jobId: `tie${String(index).padStart(3, "0")}`, created: NOW - 2 * HOUR + index * 1_000, ended: NOW - HOUR })),
    )
    const { collected, pages } = await drain(target, { since: iso(NOW - 3 * HOUR) }, 7)
    expect(collected).toHaveLength(200)
    expect(new Set(collected).size).toBe(200)
    expect(pages.every((answer) => answer["gap"] === undefined)).toBe(true)
  })

  test("a secret-shaped title is refused, with its reason, and never listed", async () => {
    const target = harness()
    serveJobs(target.bigquery, [
      job({ jobId: "ok", created: NOW - 2 * HOUR, ended: NOW - 90 * MIN }),
      job({ jobId: "secret", created: NOW - HOUR, ended: NOW - 30 * MIN, statementType: "deploy ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }),
    ])
    const answer = await page(target, { since: iso(NOW - 4 * HOUR) })
    expect(ids(answer)).toEqual(["invented-proj:US:ok"])
    expect(answer["refused"]).toEqual([expect.objectContaining({ external_id: "invented-proj:US:secret", reason: "secret" })])
  })

  test("the cursor is bound to its source, account and scope, and another binding's or a malformed state is CURSOR_INVALID", async () => {
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: NOW - HOUR, ended: NOW - 30 * MIN })])
    const scoped = await page(target, { since: iso(NOW - 2 * HOUR), scope: { projects: ["invented-proj"] } })
    const unscoped = await runTool(target, "events_list", { source: "jobs", cursor: scoped["cursor"] })
    expect(unscoped.output["error"]).toBe("CURSOR_INVALID")
    const otherAccount = encodeBoundCursor(bindingOf("other", undefined), { e: NOW, f: NOW - HOUR })
    expect((await runTool(target, "events_list", { source: "jobs", cursor: otherAccount })).output["error"]).toBe("CURSOR_INVALID")
    const otherPlugin = encodeBoundCursor({ plugin: "another-plugin", source: "jobs", account: "default" }, { e: NOW, f: NOW - HOUR })
    expect((await runTool(target, "events_list", { source: "jobs", cursor: otherPlugin })).output["error"]).toBe("CURSOR_INVALID")
    for (const state of [{ w: NOW }, { e: NOW, f: NOW, c: NOW - 1, n: NOW, i: 0 }, { e: NOW, f: NOW, c: NOW, n: NOW, i: 5 }, { e: NOW, f: NOW, c: NOW, n: NOW, i: 0, p: NOW, h: "zz" }]) {
      const bad = encodeBoundCursor(bindingOf("default", undefined), state)
      expect((await runTool(target, "events_list", { source: "jobs", cursor: bad })).output["error"], JSON.stringify(state)).toBe("CURSOR_INVALID")
    }
    const again = await page(target, { cursor: scoped["cursor"], scope: { projects: ["invented-proj"] } })
    expect(again["events"]).toEqual([])
  })

  test("the cursor stays small whatever the account, scope and position", async () => {
    // The codec binds the account and scope by hash, so neither adds to the cursor's length.
    const target = harness()
    serveJobs(
      target.bigquery,
      Array.from({ length: 30 }, (_, index) => job({ jobId: `j${index}`, created: NOW - 5 * HOUR + index * MIN, ended: NOW - HOUR })),
    )
    const projects = Array.from({ length: 40 }, (_, index) => `invented-project-${String(index).padStart(4, "0")}`)
    const answer = await page(target, { since: iso(NOW - 6 * HOUR), scope: { projects }, limit: 1 })
    expect(answer["more"]).toBe(true)
    expect(String(answer["cursor"]).length).toBeLessThanOrEqual(400)
  })

  test("an events page names its owner, its source and its account, and carries a scope when one is confirmed", async () => {
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: NOW - HOUR, ended: NOW - 30 * MIN })])
    const answer = await page(target, { since: iso(NOW - 2 * HOUR), scope: { projects: ["invented-proj"] } })
    expect(answer["source"]).toBe("jobs")
    expect(answer["account"]).toBe("default")
    expect(answer["owner"]).toEqual({ id: "mailto:ada@example.invalid", label: "ada@example.invalid" })
    expect(answer["trust"]).toBe("untrusted")
    expect(answer["scope"]).toEqual({ projects: ["invented-proj"] })
  })

  test("asserts the contract's bigquery.read on the account's jobs.list before any call, and a denial reads nothing", async () => {
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: NOW - HOUR, ended: NOW - 30 * MIN })])
    const allowed = await runTool(target, "events_list", { source: "jobs", since: iso(NOW - 2 * HOUR) })
    expect(allowed.asserted.slice(0, 2).map((request) => [request.action, request.resources])).toEqual([
      ["bigquery.events_list", ["default:bigquery.jobs.list"]],
      ["bigquery.read", ["default:bigquery.jobs.list"]],
    ])
    const denied = harness()
    serveJobs(denied.bigquery, [])
    const refused = await runTool(denied, "events_list", { source: "jobs" }, { deny: (request) => request.action === "bigquery.read" }).catch((error: unknown) => error)
    expect(String(refused)).toContain("denied")
    expect(denied.bigquery.calls.filter((entry) => entry.method === "listJobs")).toEqual([])
  })

  test("lists queued jobs before running ones at a read's start, so a job moving between them is in one", async () => {
    const target = harness()
    serveJobs(target.bigquery, [job({ jobId: "j1", created: NOW - HOUR, ended: NOW - 30 * MIN })])
    await page(target, { since: iso(NOW - 2 * HOUR) })
    const states = target.bigquery.calls.filter((entry) => entry.method === "listJobs").map((entry) => (entry.args[0] as { stateFilter: string }).stateFilter)
    expect(states.slice(0, 3)).toEqual(["pending", "running", "done"])
  })

  test("a location unreachable at a read's start is held: the others are delivered now, it is delivered when back, no gap", async () => {
    const target = harness()
    const jobs: SimJob[] = [
      { jobId: "us", created: NOW - 50 * MIN, ended: NOW - 40 * MIN, location: "US" },
      { jobId: "eu", created: NOW - 50 * MIN, ended: NOW - 40 * MIN, location: "EU" },
      { jobId: "eu-later", created: NOW + 10 * MIN, ended: NOW + 20 * MIN, location: "EU" },
    ]
    let down = true
    const sim = new Sim(target, jobs, { unreachable: () => (down ? ["EU"] : []) })
    const reading = newReading()
    target.clock.time = NOW
    await readOnce(sim, target, reading, { since: NOW - HOUR })
    expect([...reading.delivered.keys()]).toEqual(["us"])
    target.clock.time = NOW + HOUR
    await readOnce(sim, target, reading, {})
    expect([...reading.delivered.keys()]).toEqual(["us"])
    down = false
    target.clock.time = NOW + 2 * HOUR
    await readOnce(sim, target, reading, {})
    expect([...reading.delivered.keys()].sort()).toEqual(["eu", "eu-later", "us"])
    expect([...reading.delivered.values()]).toEqual([1, 1, 1])
    expect(reading.gaps).toEqual([])
    expect(reading.errors).toEqual([])
  })

  test("a location that goes dark in the middle of a read is held from where the walk was: nothing repeated or lost", async () => {
    const target = harness()
    const jobs: SimJob[] = Array.from({ length: 40 }, (_, index) => ({
      jobId: `j${index}`,
      created: NOW - 3 * HOUR + index * MIN,
      ended: NOW - HOUR + index * 30_000,
      location: index % 2 === 0 ? "US" : "EU",
    }))
    let calls = 0
    // EU is reachable for the read's start and its first walk calls, then dark for the next ten calls.
    const sim = new Sim(target, jobs, { unreachable: () => (calls >= 4 && calls < 14 ? ["EU"] : []) })
    target.bigquery.on("listJobs", async (input) => {
      const page = sim.listJobs(input)
      calls += 1
      return page
    })
    const reading = newReading()
    target.clock.time = NOW
    await readOnce(sim, target, reading, { since: NOW - 4 * HOUR, limit: 3 })
    expect(reading.errors).toEqual([])
    target.clock.time = NOW + HOUR
    await readOnce(sim, target, reading, { limit: 3 })
    for (const hours of [2, 3]) {
      target.clock.time = NOW + hours * HOUR
      await readOnce(sim, target, reading, { limit: 3 })
    }
    expect(calls).toBeGreaterThan(14)
    expect([...reading.delivered.keys()].sort()).toEqual(jobs.map((job) => job.jobId).sort())
    expect([...reading.delivered.values()].every((count) => count === 1)).toBe(true)
    expect(reading.gaps).toEqual([])
    expect(reading.errors).toEqual([])
  })

  test("a location Google names in a way no job can match fails the read with UNAVAILABLE, and the same cursor reads later", async () => {
    const target = harness()
    let odd = true
    const sim = new Sim(target, [{ jobId: "us", created: NOW - 50 * MIN, ended: NOW - 40 * MIN, location: "US" }], { unreachable: () => (odd ? ["unknown"] : []) })
    target.clock.time = NOW
    const failed = await page(target, { since: iso(NOW - HOUR) })
    expect(failed["error"]).toBe("UNAVAILABLE")
    expect(failed["retryAfterSec"]).toBe(300)
    odd = false
    const reading = newReading()
    await readOnce(sim, target, reading, { since: NOW - HOUR })
    expect([...reading.delivered.keys()]).toEqual(["us"])
  })

  test("a script's call throws the contract's error, and the model's call answers the envelope", async () => {
    const target = harness()
    serveJobs(target.bigquery, [])
    const expired = encodeBoundCursor(bindingOf("default", undefined), { e: NOW - 400 * DAY, f: NOW - 401 * DAY })
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
