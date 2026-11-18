// `bigquery.jobs` at realistic load, against the moving `jobs.list` of ./sim.ts: hundreds of jobs an hour across
// projects and locations, some queued and some running one to six hours, read hourly or every five minutes, by a
// consumer that pages slowly, pauses, or runs on a clock ahead of Google's. Every case asserts the source's promise:
// each finished job is delivered exactly once, or a gap that precedes it says it may be missing — and here, where
// nothing is lost on Google's side, no gap at all. These are review bigquery-9's probes (H1, M1, M3, LOW 1) as tests.
import { describe, expect, test } from "vitest"
import { LIST_CALLS, SETTLE_MS, UNFINISHED_CALLS } from "../../../src/sources/events.js"
import { harness } from "./support.js"
import { audit, DAY, HOUR, MIN, readOnce, newReading, Sim, simulate, workload, type SimJob } from "./sim.js"

const NOW = Date.parse("2026-11-17T12:00:00Z")
/** The cursor's worst case, measured under every load here (the contract's cap is 1,024). */
const CURSOR_CAP = 400

/** Every job that finished after `since` is owed. */
const owed = (jobs: readonly SimJob[], since: number) => jobs.filter((job) => job.ended > since && Number.isFinite(job.ended) && job.deleted === undefined)

function expectExact(reading: Awaited<ReturnType<typeof simulate>>, jobs: readonly SimJob[], since: number): void {
  const result = audit(reading, owed(jobs, since))
  expect(result.missing.slice(0, 5)).toEqual([])
  expect(result.duplicated.slice(0, 5)).toEqual([])
  expect(result.unexpected.slice(0, 5)).toEqual([])
  expect(reading.errors).toEqual([])
  expect(reading.gaps).toEqual([])
  expect(reading.disorder).toBe(0)
  expect(reading.maxCursor).toBeLessThanOrEqual(CURSOR_CAP)
}

describe("bigquery.jobs at realistic load", () => {
  test("the minimal probe: three jobs finished since the last read, read with limit 1, are all delivered", async () => {
    const target = harness()
    const jobs: SimJob[] = [
      { jobId: "a", created: NOW + 10 * MIN, ended: NOW + 11 * MIN },
      { jobId: "b", created: NOW + 20 * MIN, ended: NOW + 21 * MIN },
      { jobId: "c", created: NOW + 30 * MIN, ended: NOW + 31 * MIN },
    ]
    const sim = new Sim(target, jobs)
    const reading = newReading()
    target.clock.time = NOW
    await readOnce(sim, target, reading, { since: NOW - HOUR, limit: 1 })
    expect(reading.delivered.size).toBe(0)
    target.clock.time = NOW + HOUR
    await readOnce(sim, target, reading, { limit: 1 })
    expect([...reading.delivered.keys()].sort()).toEqual(["a", "b", "c"])
    expect(reading.gaps).toEqual([])
  })

  for (const perHour of [50, 300, 1200]) {
    test(`${perHour} jobs an hour for 48 h, 5% running 1–6 h, read hourly: each delivered once, no gap`, async () => {
      const target = harness()
      const jobs = workload({ perHour, hours: 48, start: NOW, seed: perHour })
      const sim = new Sim(target, jobs)
      const reading = await simulate(sim, target, { since: NOW, every: HOUR, until: NOW + 56 * HOUR })
      expectExact(reading, jobs, NOW)
      // One events_list call: its walk budget, plus the read's start (queued and running jobs, two listings each).
      expect(reading.maxCalls).toBeLessThanOrEqual(LIST_CALLS + 2 * UNFINISHED_CALLS)
    }, 120_000)
  }

  test("300 an hour across two projects and three locations, a fifth queued up to 2 h, read every 5 min", async () => {
    const target = harness()
    const places = [
      { project: "invented-proj", location: "US" },
      { project: "invented-proj", location: "EU" },
      { project: "invented-proj-2", location: "asia-northeast1" },
    ]
    const jobs = workload({ perHour: 300, hours: 12, start: NOW, queuedShare: 0.2, places, seed: 3 })
    const sim = new Sim(target, jobs)
    const reading = await simulate(sim, target, { since: NOW, every: 5 * MIN, until: NOW + 19 * HOUR, scope: { projects: ["invented-proj", "invented-proj-2"] } })
    expectExact(reading, jobs, NOW)
  }, 120_000)

  test("the jam: 500 jobs ending in one millisecond, limit 100, drain once each", async () => {
    const target = harness()
    const jobs: SimJob[] = Array.from({ length: 500 }, (_, index) => ({ jobId: `tie_${index}`, created: NOW + index * 1000, ended: NOW + HOUR }))
    const sim = new Sim(target, jobs)
    const reading = await simulate(sim, target, { since: NOW, every: HOUR, until: NOW + 4 * HOUR })
    expectExact(reading, jobs, NOW)
  })

  test("a jam at creation too: 250 jobs created in one millisecond, more than a jobs.list page, limit 7", async () => {
    const target = harness()
    const jobs: SimJob[] = Array.from({ length: 250 }, (_, index) => ({ jobId: `burst_${index}`, created: NOW + 5 * MIN, ended: NOW + 6 * MIN + (index % 3) }))
    const sim = new Sim(target, jobs)
    const reading = await simulate(sim, target, { since: NOW, every: HOUR, until: NOW + 2 * HOUR, limit: 7 })
    expectExact(reading, jobs, NOW)
  })

  test("pages that shift: 600 an hour, limit 50, a minute between pages, jobs finishing and deleted mid-walk", async () => {
    const target = harness()
    const random = workload({ perHour: 600, hours: 24, start: NOW, seed: 11 })
    // Every 97th job is deleted by its owner an hour after it ends: still delivered once, if it was listed in time.
    const jobs = random.map((job, index) => (index % 97 === 0 ? { ...job, deleted: job.ended + 40 * MIN } : job))
    const sim = new Sim(target, jobs)
    const reading = await simulate(sim, target, { since: NOW, every: HOUR, until: NOW + 31 * HOUR, limit: 50, perPageMs: MIN })
    const deleted = new Set(jobs.filter((job) => job.deleted !== undefined).map((job) => job.jobId))
    const result = audit(reading, owed(jobs, NOW))
    expect(result.duplicated).toEqual([])
    expect(result.unexpected.filter((id) => !deleted.has(id))).toEqual([])
    expect(reading.gaps).toEqual([])
    expect(reading.errors).toEqual([])
    expect(reading.maxCursor).toBeLessThanOrEqual(CURSOR_CAP)
    // A job deleted before any read could list it is not owed (Known limits); every other one is delivered.
    expect(owed(random, NOW).filter((job) => !deleted.has(job.jobId) && !reading.delivered.has(job.jobId))).toEqual([])
  }, 120_000)

  for (const [name, world] of [
    ["the host's clock 30 s ahead of Google's", { skewMs: 30_000 }],
    ["the host's clock 15 min ahead of Google's", { skewMs: 15 * MIN }],
    ["the host's clock 10 min behind Google's", { skewMs: -10 * MIN }],
    ["DONE listed 5 s after the end", { lagMs: 5_000 }],
    ["DONE listed 60 s after the end, and a second per jobs.list call", { lagMs: 60_000, perCallMs: 1_000 }],
  ] as const) {
    test(`Google's clock decides: ${name}, 300 an hour read every 5 min`, async () => {
      const target = harness()
      const jobs = workload({ perHour: 300, hours: 24, start: NOW, longShare: 0.05, seed: 5 })
      const sim = new Sim(target, jobs, world)
      const reading = await simulate(sim, target, { since: NOW, every: 5 * MIN, until: NOW + 26 * HOUR })
      expectExact(reading, jobs, NOW)
    }, 120_000)
  }

  for (const [name, world] of [
    ["the host's clock 15 min ahead", { date: false, skewMs: 15 * MIN }],
    ["DONE listed 60 s after the end", { date: false, lagMs: 60_000 }],
  ] as const) {
    test(`with no Date header on Google's answers, job times alone keep it exact: ${name}`, async () => {
      // Without a Date, Google's now is the newest job time an answer shows, so the last jobs of a run wait for a
      // later one; nothing is lost or repeated, and every job that ended before the newest one is delivered.
      const target = harness()
      const jobs = workload({ perHour: 300, hours: 24, start: NOW, longShare: 0.05, seed: 5 })
      const sim = new Sim(target, jobs, world)
      const reading = await simulate(sim, target, { since: NOW, every: 5 * MIN, until: NOW + 26 * HOUR })
      const result = audit(reading, owed(jobs, NOW))
      expect(result.duplicated).toEqual([])
      expect(result.unexpected).toEqual([])
      expect(reading.gaps).toEqual([])
      const waiting = jobs.filter((job) => result.missing.includes(job.jobId))
      expect(waiting.every((job) => job.ended > sim.lastEnd() - SETTLE_MS - 61_000)).toBe(true)
    }, 120_000)
  }

  test("a 7-day pause after day 1, at 300 an hour: everything is delivered after it, with no gap", async () => {
    const target = harness()
    const jobs = workload({ perHour: 300, hours: 10 * 24, start: NOW, seed: 9 })
    const sim = new Sim(target, jobs)
    const reading = await simulate(sim, target, { since: NOW, every: HOUR, until: NOW + 10 * DAY + 7 * HOUR, pauses: [{ at: NOW + DAY, to: NOW + 8 * DAY }] })
    expectExact(reading, jobs, NOW)
  }, 180_000)

  test("a 200-day pause: one expired gap, then the read goes on with what Google still keeps", async () => {
    const target = harness()
    const early = workload({ perHour: 2, hours: 24, start: NOW, seed: 2, prefix: "early" })
    const late = workload({ perHour: 20, hours: 6, start: NOW + 200 * DAY, seed: 4, prefix: "late" })
    const sim = new Sim(target, [...early, ...late])
    const reading = newReading()
    target.clock.time = NOW + MIN
    await readOnce(sim, target, reading, { since: NOW })
    target.clock.time = NOW + 2 * HOUR
    await readOnce(sim, target, reading, {})
    target.clock.time = NOW + 200 * DAY
    for (let hour = 0; hour < 14; hour++) {
      await readOnce(sim, target, reading, { limit: 3 })
      target.clock.advance(HOUR)
    }
    expect(reading.gaps.map((gap) => gap.reason)).toEqual(["expired"])
    expect(reading.errors).toEqual([])
    // The late jobs, all within six months, are delivered once each; nothing repeats.
    const result = audit(reading, late)
    expect(result.missing).toEqual([])
    expect(result.duplicated).toEqual([])
  })

  test("a job running longer than the 24 h it is tracked: one window-truncated gap, before its end", async () => {
    const target = harness()
    const long: SimJob = { jobId: "long26h", created: NOW + 10 * MIN, ended: NOW + 26 * HOUR }
    const others = workload({ perHour: 10, hours: 30, start: NOW, seed: 6, longShare: 0 })
    const sim = new Sim(target, [long, ...others])
    const reading = await simulate(sim, target, { since: NOW, every: HOUR, until: NOW + 32 * HOUR })
    expect(reading.gaps).toHaveLength(1)
    expect(reading.gaps[0]!.reason).toBe("window-truncated")
    expect(Date.parse(reading.gaps[0]!.since)).toBeLessThan(long.ended)
    const result = audit(reading, owed(others, NOW))
    expect(result.missing).toEqual([])
    expect(result.duplicated).toEqual([])
  })

  test("an unreachable location for 2 h: the read goes on without it, then delivers it, with no gap and no loss", async () => {
    const target = harness()
    const places = [{ location: "US" }, { location: "EU" }]
    const jobs = workload({ perHour: 120, hours: 12, start: NOW, places, seed: 8 })
    const down = { from: NOW + 3 * HOUR, to: NOW + 5 * HOUR }
    const sim = new Sim(target, jobs, { unreachable: (google) => (google >= down.from && google < down.to ? ["EU"] : []) })
    const reading = await simulate(sim, target, { since: NOW, every: 15 * MIN, until: NOW + 14 * HOUR })
    expectExact(reading, jobs, NOW)
  }, 120_000)

  test("a location unreachable for 8 days: no gap, no loss, and the other location is read all along", async () => {
    const target = harness()
    const places = [{ location: "US" }, { location: "EU" }]
    const jobs = workload({ perHour: 20, hours: 10 * 24, start: NOW, places, seed: 12 })
    const down = { from: NOW + DAY, to: NOW + 9 * DAY }
    const sim = new Sim(target, jobs, { unreachable: (google) => (google >= down.from && google < down.to ? ["EU"] : []) })
    const usBy = new Map<string, number>()
    const reading = newReading()
    target.clock.time = NOW + MIN
    while (target.clock.now() <= NOW + 10 * DAY) {
      await readOnce(sim, target, reading, { since: NOW })
      for (const id of reading.delivered.keys()) if (!usBy.has(id)) usBy.set(id, target.clock.now())
      target.clock.advance(6 * HOUR)
    }
    target.clock.time = sim.lastEnd() + 2 * HOUR
    await readOnce(sim, target, reading, {})
    expectExact(reading, jobs, NOW)
    // US jobs that ended during the outage were delivered within a read of their end, not after EU came back.
    const usDuring = jobs.filter((job) => job.location === "US" && job.ended > down.from && job.ended < down.to - 7 * HOUR)
    expect(usDuring.every((job) => (usBy.get(job.jobId) ?? Infinity) < down.to)).toBe(true)
  }, 120_000)
})
