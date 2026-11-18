// `bigquery.jobs` when the host's clock moves under it, and when a location is down across a consumer's pause: review
// bigquery-9 round 2's probes (H1, M1, LOW 1, LOW 2, the REALISTIC load and the cursor's worst case) as tests, on the
// moving `jobs.list` of ./sim.ts. A read's cutoff comes from Google's own time only, so no step of the host clock,
// forward or back, by seconds, minutes, hours or a day, loses or repeats a job; a location that is down is held with its
// own frontier and floor, so an outage of any length, met at any moment, loses nothing and answers no gap.
import { describe, expect, test } from "vitest"
import { MAX_DARK } from "../../../src/sources/events.js"
import { harness } from "./support.js"
import { audit, DAY, HOUR, MIN, newReading, readOnce, Sim, workload, type Reading, type SimJob } from "./sim.js"

const NOW = Date.parse("2026-11-17T12:00:00Z")
const owed = (jobs: readonly SimJob[], since: number) => jobs.filter((job) => job.ended > since && Number.isFinite(job.ended) && job.deleted === undefined)

/** Reads every `every` (host time) from `since` to `until`, calling `before(host)` ahead of each read, then drains. */
async function run(sim: Sim, target: ReturnType<typeof harness>, options: { since: number; every: number; until: number; before?: (host: number) => void; limit?: number; hostSteps?: boolean }): Promise<Reading> {
  const reading = newReading()
  target.clock.time = options.since + MIN
  while (target.clock.now() <= options.until) {
    // A new skew is a step of the host's clock: the host moves by the difference, and Google's clock goes on.
    const was = sim.world.skewMs
    options.before?.(target.clock.now())
    if (options.hostSteps !== false) target.clock.advance(sim.world.skewMs - was)
    await readOnce(sim, target, reading, { since: options.since, limit: options.limit ?? 100 })
    target.clock.advance(options.every)
  }
  if (options.hostSteps !== false) target.clock.advance(-sim.world.skewMs)
  sim.world.skewMs = 0
  target.clock.time = Math.max(target.clock.now() + HOUR, sim.lastEnd() + 2 * HOUR)
  await readOnce(sim, target, reading, { limit: options.limit ?? 100 })
  target.clock.advance(10 * MIN)
  await readOnce(sim, target, reading, { limit: options.limit ?? 100 })
  return reading
}

function expectExact(reading: Reading, jobs: readonly SimJob[], since: number): void {
  const result = audit(reading, owed(jobs, since))
  expect({ missing: result.missing.length, duplicated: result.duplicated.length, unexpected: result.unexpected.length, gaps: reading.gaps.length, errors: reading.errors }).toEqual({
    missing: 0,
    duplicated: 0,
    unexpected: 0,
    gaps: 0,
    errors: [],
  })
}

describe("bigquery.jobs when the host clock moves", () => {
  // The host is off by `before` until 6 h in, then by `after`: NTP stepping a slow or fast clock, a laptop after sleep.
  const steps: [string, number, number][] = [
    ["host 10 min behind, then corrected", -10 * MIN, 0],
    ["host 1 h behind, then corrected", -HOUR, 0],
    ["host 2 min behind, then corrected", -2 * MIN, 0],
    ["host 5 s behind, then corrected", -5_000, 0],
    ["host 10 min ahead, then corrected", 10 * MIN, 0],
    ["host 1 h ahead, then corrected", HOUR, 0],
    ["host correct, then stepped 5 s ahead", 0, 5_000],
    ["host correct, then stepped 10 min ahead", 0, 10 * MIN],
    ["host correct, then stepped 3 h ahead", 0, 3 * HOUR],
    ["host correct, then stepped 3 h back", 0, -3 * HOUR],
    ["host correct, then stepped a day ahead", 0, DAY],
  ]
  for (const [name, before, after] of steps) {
    test(`${name} (300 an hour, read every 5 min, the step after 6 h): nothing lost or repeated, no gap`, async () => {
      const target = harness()
      const jobs = workload({ perHour: 300, hours: 12, start: NOW, seed: 21 })
      const sim = new Sim(target, jobs, { skewMs: before })
      const reading = await run(sim, target, {
        since: NOW,
        every: 5 * MIN,
        until: NOW + 14 * HOUR,
        before: (host) => {
          sim.world.skewMs = host < NOW + 6 * HOUR ? before : after
        },
      })
      expectExact(reading, jobs, NOW)
    }, 120_000)
  }

  // The review's own probe moved Google's clock instead (the skew changed while the host stood still), so Google's
  // time jumped back by the correction. That never happens, but a cutoff from Google's time stays exact through it too.
  for (const [name, before, after] of steps.slice(0, 5)) {
    test(`as the review modelled it, Google's clock jumping instead: ${name}`, async () => {
      const target = harness()
      const jobs = workload({ perHour: 300, hours: 12, start: NOW, seed: 21 })
      const sim = new Sim(target, jobs, { skewMs: before })
      const reading = await run(sim, target, {
        since: NOW,
        every: 5 * MIN,
        until: NOW + 14 * HOUR,
        hostSteps: false,
        before: (host) => {
          sim.world.skewMs = host < NOW + 6 * HOUR ? before : after
        },
      })
      expectExact(reading, jobs, NOW)
    }, 120_000)
  }

  test("a clock that jumps back and forth by seconds to hours on every read", async () => {
    const target = harness()
    const jobs = workload({ perHour: 300, hours: 12, start: NOW, seed: 28 })
    const sim = new Sim(target, jobs)
    const offsets = [0, 7_000, -90_000, 2 * HOUR, -HOUR, 45 * MIN, -3_000, 0, -DAY, 12 * HOUR]
    let read = 0
    const reading = await run(sim, target, { since: NOW, every: 5 * MIN, until: NOW + 14 * HOUR, before: () => (sim.world.skewMs = offsets[read++ % offsets.length]!) })
    expectExact(reading, jobs, NOW)
  }, 120_000)

  test("a VM hibernated a day with its clock frozen: one read on wake, then NTP steps it forward", async () => {
    const target = harness()
    const jobs = workload({ perHour: 300, hours: 3 * 24, start: NOW, seed: 22 })
    const sim = new Sim(target, jobs)
    const reading = newReading()
    target.clock.time = NOW + MIN
    for (let k = 0; k < 12; k++) {
      await readOnce(sim, target, reading, { since: NOW })
      target.clock.advance(5 * MIN)
    }
    // Google moves a day on; the host clock does not, until NTP steps it.
    sim.world.skewMs = -DAY
    await readOnce(sim, target, reading, {})
    target.clock.advance(MIN)
    target.clock.advance(DAY)
    sim.world.skewMs = 0
    for (let k = 0; k < 24; k++) {
      await readOnce(sim, target, reading, {})
      target.clock.advance(5 * MIN)
    }
    target.clock.time = sim.lastEnd() + 2 * HOUR
    await readOnce(sim, target, reading, {})
    expectExact(reading, jobs, NOW)
  }, 120_000)

  for (const skew of [HOUR, -HOUR, DAY, -DAY]) {
    test(`a constant skew of ${skew / MIN} min`, async () => {
      const target = harness()
      const jobs = workload({ perHour: 300, hours: 12, start: NOW, seed: 23 })
      const sim = new Sim(target, jobs, { skewMs: skew })
      // The reads start on the host's clock, so `since` is the host's: the jobs owed are those that ended after it.
      const reading = await run(sim, target, { since: NOW + skew, every: 5 * MIN, until: NOW + skew + 14 * HOUR, before: () => (sim.world.skewMs = skew) })
      expectExact(reading, jobs, NOW + skew)
    }, 120_000)
  }

  test("a first read whose since is in Google's future (host 1 h ahead) keeps its floor at Google's now (LOW 2)", async () => {
    const target = harness()
    const jobs = workload({ perHour: 300, hours: 12, start: NOW - 2 * HOUR, seed: 29 })
    const sim = new Sim(target, jobs, { skewMs: HOUR })
    // `since` is the host's now, an hour ahead of Google: every job that ends after it is owed.
    const reading = await run(sim, target, { since: NOW + HOUR - MIN, every: 5 * MIN, until: NOW + 12 * HOUR, before: () => (sim.world.skewMs = HOUR) })
    expectExact(reading, jobs, NOW + HOUR - MIN)
  }, 120_000)
})

describe("bigquery.jobs when a location is down", () => {
  test("a cursor paused 8 days meets a 10-minute EU blip on its first read: nothing lost, no gap (M1)", async () => {
    const target = harness()
    const places = [{ location: "US" }, { location: "EU" }]
    const jobs = workload({ perHour: 60, hours: 10 * 24, start: NOW, places, seed: 24 })
    const blip = { from: NOW + 9 * DAY, to: NOW + 9 * DAY + 10 * MIN }
    const sim = new Sim(target, jobs, { unreachable: (google) => (google >= blip.from && google < blip.to ? ["EU"] : []) })
    const reading = newReading()
    target.clock.time = NOW + MIN
    for (let k = 0; k < 24; k++) {
      await readOnce(sim, target, reading, { since: NOW })
      target.clock.advance(HOUR)
    }
    target.clock.time = blip.from + MIN
    await readOnce(sim, target, reading, {})
    // That read delivered the US jobs of the pause, and held EU.
    const usPaused = jobs.filter((job) => job.location === "US" && job.ended > NOW + DAY && job.ended < blip.from - 5 * MIN)
    expect(usPaused.every((job) => reading.delivered.has(job.jobId))).toBe(true)
    target.clock.time = blip.to + 5 * MIN
    for (let k = 0; k < 30; k++) {
      await readOnce(sim, target, reading, {})
      target.clock.advance(HOUR)
    }
    target.clock.time = sim.lastEnd() + 2 * HOUR
    await readOnce(sim, target, reading, {})
    expectExact(reading, jobs, NOW)
  }, 120_000)

  test("EU down 9 days, read every 30 min: no UNAVAILABLE, no gap per read, nothing lost (LOW 1)", async () => {
    const target = harness()
    const places = [{ location: "US" }, { location: "EU" }]
    const jobs = workload({ perHour: 20, hours: 11 * 24, start: NOW, places, seed: 25 })
    const down = { from: NOW + DAY, to: NOW + 10 * DAY }
    const sim = new Sim(target, jobs, { unreachable: (google) => (google >= down.from && google < down.to ? ["EU"] : []) })
    const reading = await run(sim, target, { since: NOW, every: 30 * MIN, until: NOW + 11 * DAY })
    expectExact(reading, jobs, NOW)
  }, 300_000)

  test(`more than ${MAX_DARK} locations down at once: the read waits (UNAVAILABLE), then delivers everything`, async () => {
    const target = harness()
    const names = ["us", "eu", "asia-east1", "asia-northeast1", "europe-west2", "us-east4", "australia-southeast1"]
    const jobs = workload({ perHour: 70, hours: 10, start: NOW, places: names.map((location) => ({ location })), seed: 30 })
    const down = { from: NOW + 2 * HOUR, to: NOW + 4 * HOUR }
    const sim = new Sim(target, jobs, { unreachable: (google) => (google >= down.from && google < down.to ? names : []) })
    const reading = await run(sim, target, { since: NOW, every: 30 * MIN, until: NOW + 12 * HOUR })
    expect(reading.errors.length).toBeGreaterThan(0)
    expect(reading.errors.every((error) => error.startsWith("UNAVAILABLE: "))).toBe(true)
    const result = audit(reading, owed(jobs, NOW))
    expect({ missing: result.missing.length, duplicated: result.duplicated.length, gaps: reading.gaps.length }).toEqual({ missing: 0, duplicated: 0, gaps: 0 })
  }, 120_000)

  test("REALISTIC: 600 an hour over 3 projects × 2 locations, 10% running 1–6 h, a fifth queued, 120 tied an hour, deletions, 20 s lag, limit 37, 2 min a page, every 5 min for 2 days", async () => {
    const target = harness()
    const places = [
      { project: "invented-a", location: "US" },
      { project: "invented-a", location: "EU" },
      { project: "invented-b", location: "US" },
      { project: "invented-b", location: "asia-northeast1" },
      { project: "invented-c", location: "EU" },
      { project: "invented-c", location: "US" },
    ]
    const base = workload({ perHour: 600, hours: 48, start: NOW, longShare: 0.1, queuedShare: 0.2, places, seed: 26 })
    const ties: SimJob[] = []
    for (let hour = 0; hour < 48; hour++) for (let k = 0; k < 120; k++) ties.push({ jobId: `tie${hour}_${k}`, created: NOW + hour * HOUR + 7 * MIN, ended: NOW + hour * HOUR + 9 * MIN, ...places[k % places.length]! })
    const jobs = [...base, ...ties].map((job, index) => (index % 89 === 0 ? { ...job, deleted: job.ended + 3 * HOUR } : job))
    const sim = new Sim(target, jobs, { lagMs: 20_000, perCallMs: 300 })
    const scope = { projects: ["invented-a", "invented-b", "invented-c"] }
    const reading = newReading()
    target.clock.time = NOW + MIN
    while (target.clock.now() < NOW + 50 * HOUR) {
      await readOnce(sim, target, reading, { since: NOW, limit: 37, perPageMs: 2 * MIN, scope })
      target.clock.advance(5 * MIN)
    }
    target.clock.time = sim.lastEnd() + 2 * HOUR
    await readOnce(sim, target, reading, { limit: 37, scope })
    const deleted = new Set(jobs.filter((job) => job.deleted !== undefined).map((job) => job.jobId))
    const result = audit(reading, owed(jobs, NOW))
    expect({ missing: result.missing.filter((id) => !deleted.has(id)).length, duplicated: result.duplicated.length, gaps: reading.gaps.length, errors: reading.errors.length }).toEqual({ missing: 0, duplicated: 0, gaps: 0, errors: 0 })
    expect(reading.maxCursor).toBeLessThanOrEqual(400)
  }, 600_000)

  test(`the cursor's worst case: a 40-project scope, mid-read, with ${MAX_DARK} locations held mid-read, of the longest names`, async () => {
    const target = harness()
    const projects = Array.from({ length: 40 }, (_, k) => `invented-project-${String(k).padStart(2, "0")}-abcdefghij`)
    const names = Array.from({ length: MAX_DARK }, (_, k) => `${"northamerica-northeast".padEnd(31, "x")}${k}`)
    const places = projects.flatMap((project) => [...names, "us"].map((location) => ({ project, location })))
    const jobs = workload({ perHour: 2000, hours: 30, start: NOW, longShare: 0.2, places, seed: 27 })
    // Each location goes dark a little after the last, so each is held in the middle of a slow read.
    const sim = new Sim(target, jobs, { unreachable: (google) => names.filter((_, k) => google > NOW + 6 * HOUR + k * 7 * MIN) })
    const reading = newReading()
    target.clock.time = NOW + MIN
    for (let k = 0; k < 12; k++) {
      await readOnce(sim, target, reading, { since: NOW, limit: 1, maxPages: 40, scope: { projects } }).catch(() => undefined)
      target.clock.advance(HOUR)
    }
    expect(reading.errors).toEqual([])
    expect(reading.maxCursor).toBeGreaterThan(600)
    expect(reading.maxCursor).toBeLessThanOrEqual(1024)
  }, 600_000)
})
