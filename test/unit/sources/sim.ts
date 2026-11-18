// A moving `jobs.list`, for the `bigquery.jobs` source's load tests: jobs are created, queue, run and finish on
// **Google's** clock, which may run behind or ahead of the host's; a state is listed only some time after it happens;
// a location can be unreachable; an owner can delete a job; history older than six months is gone. It answers the
// way the reference documents (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/list): one walk per
// project over every location, `minCreationTime`/`maxCreationTime` inclusive, newest created first, `stateFilter`, and
// `unreachable[]` naming the skipped locations. Its page tokens are positional (an offset), the worst case for a walk
// that a job finishing or being deleted mid-walk could shift; jobs created in the same millisecond come in an order of
// their own, which is not the source's.
import type { Page, JobStatus, ListInput } from "../../../src/ports.js"
import { jobResource, jobStatusOf, LOCATION, PROJECT, runTool, type Harness } from "./support.js"

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

export interface SimJob {
  readonly jobId: string
  /** Creation time, Google's clock. */
  readonly created: number
  /** When it starts running; until then it is PENDING. Default: at creation. */
  readonly started?: number
  /** When it ends; `Infinity` for one that never does. */
  readonly ended: number
  readonly project?: string
  readonly location?: string
  readonly statementType?: string
  /** When its owner deleted it, Google's clock. */
  readonly deleted?: number
}

export interface World {
  /** The host clock minus Google's: positive when the host is ahead. */
  skewMs: number
  /** A creation, start or end is listed this long after it happens. */
  lagMs: number
  /** Host time one `jobs.list` call takes. */
  perCallMs: number
  /** History kept, by creation time. */
  retentionMs: number
  /** The locations Google cannot reach at this Google time. */
  unreachable: (google: number) => readonly string[]
  /** Whether answers carry their HTTP Date (Google's clock, to the second). */
  date: boolean
  calls: number
}

/** A small seeded PRNG, so every run is the same. */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

const salted = (id: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index) ^ 0x5a, 0x01000193) >>> 0
  return hash
}

export class Sim {
  readonly world: World
  private readonly jobs: SimJob[]

  constructor(
    private readonly target: Harness,
    jobs: readonly SimJob[],
    world: Partial<World> = {},
  ) {
    this.world = { skewMs: 0, lagMs: 0, perCallMs: 0, retentionMs: 181 * DAY, unreachable: () => [], date: true, calls: 0, ...world }
    this.jobs = [...jobs].sort((left, right) => right.created - left.created || salted(left.jobId) - salted(right.jobId))
    target.bigquery.on("listJobs", async (input) => this.listJobs(input))
  }

  /** The last finite end, Google's clock. */
  lastEnd(): number {
    return Math.max(...this.jobs.map((job) => (Number.isFinite(job.ended) ? job.ended : 0)))
  }

  /** Google's now. */
  google(): number {
    return this.target.clock.now() - this.world.skewMs
  }

  private stateAt(job: SimJob, google: number): "DONE" | "RUNNING" | "PENDING" | undefined {
    const seen = google - this.world.lagMs
    if (job.created > seen || (job.deleted !== undefined && job.deleted <= google) || job.created < google - this.world.retentionMs) return undefined
    if (job.ended <= seen) return "DONE"
    return (job.started ?? job.created) <= seen ? "RUNNING" : "PENDING"
  }

  private firstAtOrBelow(max: number | undefined): number {
    if (max === undefined) return 0
    let low = 0
    let high = this.jobs.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.jobs[middle]!.created > max) low = middle + 1
      else high = middle
    }
    return low
  }

  listJobs(input: ListInput & { readonly project: string; readonly stateFilter?: "done" | "pending" | "running"; readonly minCreationTime?: number; readonly maxCreationTime?: number }): Page<JobStatus> {
    this.world.calls += 1
    const google = this.google()
    this.target.clock.advance(this.world.perCallMs)
    if (input.stateFilter === undefined) throw new Error("jobs.list: the source always names a state")
    if ((input.maxResults ?? 0) < 1 || (input.maxResults ?? 0) > 1000) throw new Error("jobs.list: maxResults out of range")
    if (input.minCreationTime !== undefined && input.maxCreationTime !== undefined && input.minCreationTime > input.maxCreationTime) {
      throw new Error("jobs.list: minCreationTime is after maxCreationTime")
    }
    const want = input.stateFilter.toUpperCase()
    const down = new Set(this.world.unreachable(google))
    const offset = input.pageToken === undefined ? 0 : Number(input.pageToken)
    if (!Number.isInteger(offset) || offset < 0) throw new Error("jobs.list: unknown pageToken")
    const size = input.maxResults!
    const matched: SimJob[] = []
    for (let index = this.firstAtOrBelow(input.maxCreationTime); index < this.jobs.length; index++) {
      const job = this.jobs[index]!
      if (input.minCreationTime !== undefined && job.created < input.minCreationTime) break
      if ((job.project ?? PROJECT) !== input.project || down.has(job.location ?? LOCATION)) continue
      if (this.stateAt(job, google) !== want) continue
      matched.push(job)
      if (matched.length > offset + size) break
    }
    const slice = matched.slice(offset, offset + size)
    const items = slice.map((job) =>
      jobStatusOf(
        jobResource({
          jobId: job.jobId,
          created: job.created,
          ended: job.ended,
          state: want as "DONE",
          bytesBilled: 1_048_576,
          statementType: job.statementType ?? "SELECT",
          ...(job.project !== undefined ? { project: job.project } : {}),
          ...(job.location !== undefined ? { location: job.location } : {}),
        }),
      ),
    )
    return {
      items,
      ...(matched.length > offset + size ? { nextPageToken: String(offset + size) } : {}),
      ...(down.size > 0 ? { unreachable: [...down] } : {}),
      ...(this.world.date ? { serverTime: Math.floor(google / 1000) * 1000 } : {}),
    }
  }
}

/** A steady workload: `perHour` jobs an hour; `longShare` of them run 1–6 h, the rest a second to a minute. */
export function workload(options: {
  readonly perHour: number
  readonly hours: number
  readonly start: number
  readonly longShare?: number
  readonly queuedShare?: number
  readonly seed?: number
  readonly prefix?: string
  readonly places?: readonly { readonly project?: string; readonly location?: string }[]
}): SimJob[] {
  const random = rng(options.seed ?? 7)
  const total = Math.round(options.perHour * options.hours)
  const jobs: SimJob[] = []
  for (let index = 0; index < total; index++) {
    const created = options.start + Math.floor((index / total) * options.hours * HOUR) + Math.floor(random() * 1000)
    const long = random() < (options.longShare ?? 0.05)
    const queued = random() < (options.queuedShare ?? 0) ? Math.floor(random() * 2 * HOUR) : 0
    const duration = long ? HOUR + Math.floor(random() * 5 * HOUR) : 1000 + Math.floor(random() * 59_000)
    const place = options.places?.[Math.floor(random() * options.places.length)] ?? {}
    jobs.push({ jobId: `${options.prefix ?? "job"}_${index}`, created, started: created + queued, ended: created + queued + duration, ...place })
  }
  return jobs
}

export interface Reading {
  cursor?: string
  readonly delivered: Map<string, number>
  readonly gaps: { readonly at: number; readonly reason: string; readonly since: string }[]
  readonly errors: string[]
  pages: number
  maxCursor: number
  /** The most `jobs.list` calls one `events_list` call made. */
  maxCalls: number
  /** Delivered events whose `occurred_at` is out of order within a page. */
  disorder: number
}

export const newReading = (): Reading => ({ delivered: new Map(), gaps: [], errors: [], pages: 0, maxCursor: 0, maxCalls: 0, disorder: 0 })

/** One read: pages until `more` is false, as a consumer drains; an error leaves the cursor where it was. */
export async function readOnce(
  sim: Sim,
  target: Harness,
  reading: Reading,
  options: { readonly since?: number; readonly limit?: number; readonly perPageMs?: number; readonly scope?: Record<string, string[]>; readonly maxPages?: number } = {},
): Promise<void> {
  for (let page = 0; page < (options.maxPages ?? 5_000); page++) {
    const before = sim.world.calls
    const input = {
      source: "jobs",
      ...(reading.cursor !== undefined ? { cursor: reading.cursor } : options.since !== undefined ? { since: new Date(options.since).toISOString() } : {}),
      limit: options.limit ?? 100,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
    }
    const answer = (await runTool(target, "events_list", input)).output as Record<string, unknown>
    reading.maxCalls = Math.max(reading.maxCalls, sim.world.calls - before)
    if (typeof answer["error"] === "string") {
      reading.errors.push(`${answer["error"]}: ${String(answer["message"])}`)
      return
    }
    reading.pages += 1
    const events = (answer["events"] as { external_id: string; occurred_at: string }[]) ?? []
    for (let index = 1; index < events.length; index++) if (events[index - 1]!.occurred_at > events[index]!.occurred_at) reading.disorder += 1
    for (const event of events) {
      const id = event.external_id.split(":").pop()!
      reading.delivered.set(id, (reading.delivered.get(id) ?? 0) + 1)
    }
    const gap = answer["gap"] as { reason: string; since: string } | undefined
    if (gap !== undefined) reading.gaps.push({ at: target.clock.now(), reason: gap.reason, since: gap.since })
    reading.cursor = answer["cursor"] as string
    reading.maxCursor = Math.max(reading.maxCursor, reading.cursor.length)
    if (options.perPageMs !== undefined) target.clock.advance(options.perPageMs)
    if (answer["more"] !== true) return
  }
  throw new Error("the read did not finish")
}

/** Reads every `every` from `since` until `until` (host time), with optional pauses, then drains twice more. */
export async function simulate(
  sim: Sim,
  target: Harness,
  options: {
    readonly since: number
    readonly every: number
    readonly until: number
    readonly limit?: number
    readonly perPageMs?: number
    readonly pauses?: readonly { readonly at: number; readonly to: number }[]
    readonly scope?: Record<string, string[]>
    readonly settle?: number
  },
): Promise<Reading> {
  const reading = newReading()
  target.clock.time = options.since + MIN
  while (target.clock.now() <= options.until) {
    await readOnce(sim, target, reading, options)
    const pause = options.pauses?.find((entry) => target.clock.now() >= entry.at && target.clock.now() < entry.to)
    if (pause !== undefined) target.clock.time = pause.to
    else target.clock.advance(options.every)
  }
  // Two last reads after everything has finished, so every job is owed by now.
  target.clock.time = Math.max(target.clock.now() + (options.settle ?? HOUR), sim.lastEnd() + sim.world.skewMs + HOUR)
  await readOnce(sim, target, reading, options)
  target.clock.advance(10 * MIN)
  await readOnce(sim, target, reading, options)
  return reading
}

/** What a run delivered against what it owed: missing, duplicated and unexpected ids. */
export function audit(reading: Reading, owed: readonly SimJob[]): { missing: string[]; duplicated: string[]; unexpected: string[] } {
  const expected = new Set(owed.map((job) => job.jobId))
  return {
    missing: [...expected].filter((id) => !reading.delivered.has(id)),
    duplicated: [...reading.delivered].filter(([, count]) => count > 1).map(([id]) => id),
    unexpected: [...reading.delivered.keys()].filter((id) => !expected.has(id)),
  }
}
