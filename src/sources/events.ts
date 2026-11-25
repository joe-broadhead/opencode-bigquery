/**
 * `bigquery.jobs`, the plugin's events source (design §10): one event per finished job the signed-in person started,
 * from `jobs.list` (`allUsers: false`), which is free and keeps job history six months
 * (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/list).
 *
 * **What `jobs.list` gives, and what it does not.** It filters on **creation** time (`minCreationTime`,
 * `maxCreationTime`, both inclusive) and on state (`stateFilter`), lists every location of the project in one walk and
 * names any location it skipped in `unreachable[]`, and sorts newest **created** first. It has no filter on end time.
 * An event is a job's end, so a job created hours ago can finish now. Queries and load jobs run at most 6 h a try, and
 * BigQuery may try a query three times, up to 18 h (https://cloud.google.com/bigquery/quotas).
 *
 * **The design, from first principles.** Every time below is Google's.
 * - The source remembers an **end frontier** `e` (every job that ended at or before `e` was delivered) and a
 *   **creation floor** `f` (every job that can still end after `e` was created at or after `f`).
 * - A read fixes a **cutoff** `c` and delivers exactly the jobs that ended in `(e, c]`, then sets `e = c`. Each job ends
 *   once, so it falls in exactly one read's range: nothing is delivered twice, whatever the paging, ties or timing, and
 *   no list of ids is kept.
 * - `c` is Google's now, less a 2-minute settle margin. Google's now is the HTTP `Date` of the read's first answer
 *   (or, without one, the newest creation or end time its start's answers hold): Google's own clock, never the host's,
 *   so no step of the host clock, forward or back, by seconds or by a day, can move `c` past a job not yet listed. The
 *   margin covers the start's own calls and the lag between a job's end and its listing as DONE.
 * - To find every job ending in `(e, c]` the read lists the DONE jobs created in `[f, c]`. The next floor sits below
 *   every job still queued or running when this read started (listed PENDING, then RUNNING: a job only moves forward,
 *   so one moving between the two calls is in one of them) and below every job seen finished after `c`, and never above
 *   `c`. A job running for hours keeps the floor below it until it ends; then the floor moves up.
 * - A job still unfinished more than 24 h after its creation (past every query's 18 h) is no longer tracked: the read
 *   says so with `gap: window-truncated`, once, rather than lose it silently.
 *
 * **Paging.** A read walks the projects in order, each newest-created first, paging by creation time (the next call's
 * `maxCreationTime` is the lowest creation time seen, and the jobs at that millisecond are listed again and skipped by
 * id) rather than by page token, so a job that finishes or is deleted mid-walk cannot shift the walk past another. A
 * millisecond holding a whole page is walked by Google's token. The position carried between pages is `(creation,
 * id hash)`, so a burst at one millisecond drains exactly once. A page is cut by `limit` and the declared `maxBytes`;
 * one `events_list` call makes at most `LIST_CALLS` walk calls and may answer fewer events with `more: true`.
 *
 * **The three bugs the family's reviews keep finding.**
 * - *the sliding gap*: no line is ever recomputed from "now": `e`, `f` and the read's `c` are carried in the cursor;
 * - *the jam*: the range is a set of jobs, not a count, and the walk's position is `(creation, hash)`, so any burst
 *   drains; delivery is decided by end time against `(e, c]`, which no tie can confuse;
 * - *a gap once per read*: a gap is answered on the page that finds it, and `g` keeps every later page of the same read
 *   from answering another. Every gap's `since` is the read's `e`, so one gap covers whatever that read could lose.
 *
 * **Unreachable locations.** `jobs.list` walks every location and names the ones it skipped. A location skipped in
 * any project at a read's start is **held** in every project of the scope: the cursor keeps its frontier and floor from then (`d`, at most four), the read
 * delivers the other locations, and none of the held one's jobs. When Google reaches it again, that read walks it from
 * its own floor and delivers what ended after its own frontier, so an outage of any length loses nothing and answers no
 * gap; only six months' retention can, and then the read says `expired`. A location that goes dark in the middle of a
 * read is held from that point: the cursor also keeps that read's cutoff and the walk's position, so the catch-up skips
 * exactly the jobs the read had already delivered. More than four held at once, or a cursor that cannot hold them, fails
 * the page with `UNAVAILABLE`, and the cursor waits.
 *
 * **Expiry.** Job history is kept six months. A cursor whose floor is older answers `gap: { reason: "expired" }` once,
 * with the floor raised to what Google still keeps, and reads on. `noExpiry` is false.
 *
 * `title` is the statement type and what was billed, from the listing alone; `text` is empty (a job's SQL holds
 * literals and may hold secrets). Every title passes the contract's secret screen, so a refused job is in `refused[]`
 * with `reason: "secret"`, never in `events[]`.
 */
import { type EventsListResult, type EventsOwner, eventsListResult, fitPage, makeEvent, parseEventsListInput, type RefusedEvent, type Scope, type SourceEvent, screenEvents, startTime } from "@we-the-rebel-alliance/plugin-contract/events"
import { PACKAGE } from "../constants.js"
import { PROJECT_ID } from "../domain/reference.js"
import { formatBytes } from "../guards/cost.js"
import { settingsOf } from "../guards/settings.js"
import type { Options } from "../options.js"
import type { JobStatus, Ports } from "../ports.js"
import { type Binding, bindingOf, type CursorState, type Dark, decodeState, encodeState, hashOf, iso } from "./cursor.js"
import { sourceError } from "./errors.js"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The margin between Google's now and a read's cutoff: a job is listed DONE within it of its end. */
export const SETTLE_MS = 2 * MINUTE
/** How long after its creation a still-running job is tracked: past a query's 18 h with retries. */
export const LOOKBACK_MS = 24 * HOUR
/** Six months of job history (jobs.list: "available for a six month period after creation"), counted short. */
export const RETENTION_MS = 180 * DAY
/** At most this many (project, location) pairs are held for an outage at once; more fails the read (`UNAVAILABLE`). */
export const MAX_DARK = 4
/** At most this many walk calls per `events_list` call. */
export const LIST_CALLS = 20
/** At most this many calls list one project's queued or running jobs when a read starts. */
export const UNFINISHED_CALLS = 10
/** A `jobs.list` page. A full-projection job resource carries its configuration and statistics; 100 keeps it small. */
export const JOBS_PER_CALL = 100
/** The source's declared `maxBytes`, passed to `fitPage`, so a page keeps the size the descriptor promises. */
export const MAX_PAGE_BYTES = 262_144

/** What a source read needs: the ports, the options, the account the register resolved and the call's signal. */
export interface SourceDeps {
  readonly ports: Ports
  readonly options: Options
  readonly account: string
  readonly sessionID: string
  readonly signal: AbortSignal
}

/** One listed job, with what the walk and the event need. */
interface Item {
  readonly id: string
  readonly hash: string
  readonly creation: number
  readonly end?: number
  readonly project: string
  readonly jobId: string
  readonly location: string
  readonly statementType?: string
  readonly billed?: number
  readonly ocTool?: string
}

type Gap = NonNullable<EventsListResult["gap"]>

function itemOf(status: JobStatus, project: string): Item | undefined {
  // Google always reports a job's creation time; one without it cannot be placed in the walk, so it is not listed.
  if (status.creationTime === undefined) return undefined
  const location = status.ref.location ?? ""
  const id = `${status.ref.projectId || project}:${location}:${status.ref.jobId}`
  return {
    id,
    hash: hashOf(id),
    creation: status.creationTime,
    ...(status.state === "DONE" && status.endTime !== undefined ? { end: status.endTime } : {}),
    project: status.ref.projectId || project,
    jobId: status.ref.jobId,
    location,
    ...(status.statementType !== undefined ? { statementType: status.statementType } : {}),
    ...(status.totalBytesBilled !== undefined ? { billed: status.totalBytesBilled } : {}),
    ...(status.labels?.oc_tool !== undefined ? { ocTool: status.labels.oc_tool } : {}),
  }
}

/**
 * Whether a held location's job was delivered by the read that saw it go dark: it ended by that read's cutoff and the
 * walk had passed it (an earlier project, or a later creation, or the same creation and an id hash at most the one the
 * walk stood on).
 */
function deliveredBefore(held: Dark, index: number, item: Item): boolean {
  if (held.length !== 8 || item.end === undefined || item.end > held[4]) return false
  const [, , , , , at, creation, hash] = held
  return index < at || (index === at && creation >= 0 && (item.creation > creation || (item.creation === creation && item.hash <= hash)))
}

/** Walk order: newest created first, then by id hash, then by id. */
const walkOrder = (left: Item, right: Item): number => right.creation - left.creation || (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

/**
 * One `jobs.list` walk of one project, state and creation range, newest created first, paged by creation time. Each
 * call asks for jobs created at or before the lowest creation time seen so far and skips the ids it has already
 * returned; only a page that is all one millisecond is followed by its token.
 */
class Listing {
  private upper: number | undefined
  private token: string | undefined
  private readonly seen = new Set<string>()
  done = false
  /** The lowest creation time fetched: every millisecond above it is complete. */
  lowest: number | undefined
  /** The newest job timestamp fetched (creation or end), and the HTTP Date of the first answer. */
  newest: number | undefined
  firstDate: number | undefined
  private calls = 0

  constructor(
    private readonly deps: SourceDeps,
    private readonly index: number,
    private readonly project: string,
    private readonly state: "done" | "pending" | "running",
    private readonly min: number,
    upper: number | undefined,
    private readonly onUnreachable: (index: number, locations: readonly string[]) => void,
  ) {
    this.upper = upper
  }

  async fetch(): Promise<Item[]> {
    const page = await this.deps.ports.bigquery.listJobs(
      {
        account: this.deps.account,
        project: this.project,
        stateFilter: this.state,
        minCreationTime: this.min,
        ...(this.upper !== undefined ? { maxCreationTime: this.upper } : {}),
        maxResults: JOBS_PER_CALL,
        ...(this.token !== undefined ? { pageToken: this.token } : {}),
      },
      this.deps.signal,
    )
    if (this.calls === 0 && page.serverTime !== undefined) this.firstDate = page.serverTime
    this.calls += 1
    if (page.unreachable !== undefined && page.unreachable.length > 0) this.onUnreachable(this.index, page.unreachable)
    const fresh: Item[] = []
    let low: number | undefined
    let high: number | undefined
    for (const status of page.items) {
      const item = itemOf(status, this.project)
      if (item === undefined || item.creation < this.min || (this.upper !== undefined && item.creation > this.upper)) continue
      low = low === undefined ? item.creation : Math.min(low, item.creation)
      high = high === undefined ? item.creation : Math.max(high, item.creation)
      const stamp = Math.max(item.creation, item.end ?? 0)
      this.newest = this.newest === undefined ? stamp : Math.max(this.newest, stamp)
      if (this.seen.has(item.id)) continue
      this.seen.add(item.id)
      fresh.push(item)
    }
    if (low !== undefined) this.lowest = this.lowest === undefined ? low : Math.min(this.lowest, low)
    if (page.nextPageToken === undefined) {
      this.done = true
    } else if (low === undefined || low === high) {
      // A page that is all one millisecond (or empty) cannot move the creation bound: follow Google's token.
      this.token = page.nextPageToken
    } else {
      this.upper = low
      this.token = undefined
    }
    return fresh
  }
}

/** The owner every page names: the signed-in account, by its address when Google reports one. */
async function ownerOf(deps: SourceDeps): Promise<EventsOwner> {
  const identity = await deps.ports.auth.identity(deps.account, deps.signal)
  const email = identity.email
  return email !== undefined ? { id: `mailto:${email}`, label: email } : { id: `bigquery:account:${deps.account}`, label: `BigQuery account ${deps.account}` }
}

/** The projects a page reads, in the order the walk visits them: the confirmed scope's, or the billing project. */
function projectsOf(deps: SourceDeps, scope: Scope | undefined): readonly string[] {
  const settings = settingsOf(deps.options, deps.account)
  const named = scope?.projects
  if (named === undefined) {
    const project = settings.billingProject
    if (!project) {
      throw sourceError("INPUT_INVALID", `The account ${deps.account} has no billing project, so it names no jobs to read.`, "Set the account's billingProject, or pass the scope's projects.")
    }
    return [project]
  }
  const values = Array.isArray(named) ? named : [named]
  const projects = [...new Set(values.map(String))].sort()
  for (const project of projects) {
    if (!PROJECT_ID.test(project)) {
      throw sourceError("INPUT_INVALID", "A project in the scope is not a Google Cloud project id.", "Pass project ids such as my-project-1234 in scope.projects.")
    }
  }
  if (projects.length === 0) {
    throw sourceError("INPUT_INVALID", "The scope names no project.", "Pass at least one project id in scope.projects, or omit the scope to read the billing project.")
  }
  return projects
}

/** A job's console link, on the declared host; the location is on the link because job ids are per location. */
function consoleUrl(item: Item): string | null {
  if (!PROJECT_ID.test(item.project)) return null
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(item.jobId)) return null
  const location = /^[A-Za-z0-9-]{2,64}$/.test(item.location) ? `&location=${encodeURIComponent(item.location)}` : ""
  return `https://console.cloud.google.com/bigquery?project=${encodeURIComponent(item.project)}&j=${encodeURIComponent(item.jobId)}&page=job_details${location}`
}

/** The title, from the listing alone. The type is provider text, so it reaches the secret screen like any title. */
function titleOf(item: Item): string {
  const type = item.statementType !== undefined && item.statementType.length > 0 ? item.statementType.slice(0, 64) : "Job"
  return item.billed === undefined ? type : `${type} — ${formatBytes(item.billed)} billed`
}

/** A location name as words: Google's text, shown only when it is location-shaped. */
const locationWords = (locations: readonly string[]): string => {
  const shown = [...new Set(locations.filter((location) => /^[A-Za-z0-9-]{1,64}$/.test(location) && location !== "unknown"))].slice(0, 5)
  return shown.length > 0 ? `the location${shown.length > 1 ? "s" : ""} ${shown.join(", ")}` : "a location"
}

/** A page of the source, before the contract's envelope. */
export async function eventsPage(deps: SourceDeps, input: unknown): Promise<EventsListResult> {
  const parsed = parseEventsListInput(input, { scopeKeys: ["projects"] })
  if (!parsed.ok) {
    throw sourceError("INPUT_INVALID", `The events_list input is invalid: ${parsed.problems.join("; ")}`, "Pass source, account, since, cursor, limit or scope.projects as the source's descriptor describes them.")
  }
  const value = parsed.value
  if (deps.account === "*") {
    throw sourceError("INPUT_INVALID", "The call named no account, and this plugin has several.", "Pass the account to read, as probe answers it.")
  }
  if (value.source !== undefined && value.source !== "jobs") {
    throw sourceError("SOURCE_UNKNOWN", `This source is named jobs, not ${value.source}.`, "Pass source jobs, or omit it.")
  }
  const scope = value.scope as Scope | undefined
  const projects = projectsOf(deps, scope)
  const binding = bindingOf(deps.account, scope)
  const limit = Math.min(value.limit ?? 100, 500)
  const hostNow = deps.ports.clock.now()

  let state: CursorState
  if (value.cursor !== undefined) {
    const decoded = decodeState(binding, value.cursor)
    if (!decoded.ok) throw sourceError("CURSOR_INVALID", decoded.what, "Start again with since, or pass the cursor with the source, account and scope it was issued for.")
    state = decoded.state
    if (state.i !== undefined && state.i >= projects.length) {
      throw sourceError("CURSOR_INVALID", "The cursor's position names a project the scope does not have.", "Start again with since.")
    }
  } else {
    // A first read covers its `since` (or the contract's 24 h): jobs that ended after it, created up to a day before.
    const since = startTime({ since: value.since }, hostNow)
    state = { e: since, f: since - LOOKBACK_MS }
  }

  // The register asserted the method's declared operations before this handler ran.
  const owner = await ownerOf(deps)

  let gap: Gap | undefined
  const answerGap = (reason: Gap["reason"], since = state.e) => {
    if (state.g === 1) return
    gap = { reason, since: iso(since) }
    state.g = 1
  }

  // A read in progress whose floor is past what Google keeps starts again from its frontier (the start answers it).
  if (state.c !== undefined && state.f < hostNow - RETENTION_MS) {
    state = { e: state.e, f: state.f, ...(state.d !== undefined ? { d: state.d } : {}), ...(state.g === 1 ? { g: 1 as const } : {}) }
  }

  // Locations Google skipped. At a read's start one is held (its own frontier and floor in the
  // cursor) and the read goes on without it; one that goes dark mid-read is held from where the walk was.
  const dark: Dark[] = state.d !== undefined ? state.d.map((entry) => [...entry] as Dark) : []
  const entryOf = (location: string) => dark.find((entry) => entry[0] === location.toLowerCase())
  const floorOf = () => Math.min(state.f, ...dark.map((entry) => entry[2]))
  const startDark = new Set<string>()
  let starting = state.c === undefined
  const unavailable = (locations: readonly string[], why: string) =>
    sourceError("UNAVAILABLE", `BigQuery reported ${locationWords(locations)} unreachable ${why}, so nothing was read.`, "Call the source again later with the same cursor; nothing is lost while it waits.")
  const noteUnreachable = (_index: number, locations: readonly string[]) => {
    for (const raw of locations) {
      const location = raw.toLowerCase()
      if (location === "unknown" || !/^[a-z0-9-]{1,32}$/.test(location)) throw unavailable([raw], "under a name this source cannot match to its jobs")
      if (starting) startDark.add(location)
      else {
        // Dark from here on in this read: hold it with this read's frontier and floor, and where the walk was, so its
        // catch-up later skips exactly the jobs this read has already delivered.
        const entry = entryOf(location)
        const at: [number, number, number, string] = [state.c!, state.i!, state.p ?? -1, state.h ?? ""]
        if (entry === undefined) {
          if (dark.length >= MAX_DARK) throw unavailable([...dark.map((held) => held[0]), raw], `in more than ${MAX_DARK} locations at once`)
          dark.push([location, state.e, state.f, 0, ...at])
          state.d = dark
        } else if (entry[3] === 1) {
          if (entry.length === 8) throw unavailable([raw], "again while it was being caught up")
          entry[3] = 0
          entry.push(...at)
        }
      }
    }
  }

  let first: { readonly listing: Listing; readonly items: Item[] } | undefined
  if (starting) {
    const started = await startRead(deps, projects, state, floorOf, noteUnreachable)
    first = started
    starting = false
    // Held locations: a new one keeps this read's frontier and floor; one Google reaches again is walked from its own.
    for (const location of startDark) if (entryOf(location) === undefined) dark.push([location, state.e, state.f, 0])
    for (const entry of dark) entry[3] = startDark.has(entry[0]) ? 0 : 1
    if (dark.length > MAX_DARK) throw unavailable(dark.map((entry) => entry[0]), `in more than ${MAX_DARK} locations at once`)
    const googleNow = started.googleNow
    state.c = googleNow === undefined ? state.e : Math.max(state.e, googleNow - SETTLE_MS)
    // The next floor: below every job still queued or running (tracked for a day after its creation), never above
    // what Google has shown less the margin. With no Google time at all the floors stay where they are.
    let next = googleNow === undefined ? Math.min(state.f, ...dark.filter((entry) => entry[3] === 1).map((entry) => entry[2])) : googleNow - SETTLE_MS
    let untracked = false
    if (!started.complete) next = Math.min(next, state.f)
    for (const creation of started.unfinished) {
      if (creation < state.c - LOOKBACK_MS) untracked = true
      else next = Math.min(next, creation)
    }
    if (untracked) answerGap("window-truncated")
    // History older than six months may be gone: a floor older than that, the read's or a held location's, says so.
    const retained = (googleNow ?? hostNow) - RETENTION_MS
    const expired = [...(state.f < retained ? [state.e] : []), ...dark.filter((entry) => entry[2] < retained).map((entry) => entry[1])]
    if (expired.length > 0) answerGap("expired", Math.min(...expired))
    for (const entry of dark) entry[2] = Math.max(entry[2], retained)
    state.f = Math.max(state.f, retained)
    state.n = Math.max(next, retained)
    state.i = 0
    delete state.p
    delete state.h
  }
  if (dark.length > 0) state.d = dark
  else delete state.d
  if (state.c === undefined || state.n === undefined || state.i === undefined) throw new Error("bigquery.jobs: a read started without its cutoff")

  const cutoff = state.c
  const frontier = state.e
  const collected: SourceEvent[] = []
  const refused: RefusedEvent[] = []
  let calls = first === undefined ? 0 : 1

  /** Offers one job ending in the read's range to the page; false when the page is full and it was not taken. */
  const offer = (item: Item): boolean => {
    const event = makeEvent({
      source: "jobs",
      account: deps.account,
      external_id: item.id,
      kind: "x-bigquery/job" as never,
      occurred_at: item.end!,
      title: titleOf(item),
      text: "",
      url: consoleUrl(item),
      labels: [item.statementType, "DONE", item.ocTool].filter((label): label is string => typeof label === "string" && label.length > 0),
      actors: [{ role: "author", id: owner.id }],
    })
    const screened = screenEvents([event], { ownedBy: () => true })
    if (screened.refused.length > 0) {
      refused.push(...screened.refused)
      return true
    }
    const next = [...collected, ...screened.events]
    if (next.length > limit || fitPage(next, limit, MAX_PAGE_BYTES) < next.length) return false
    collected.push(...screened.events)
    return true
  }

  for (let index = state.i; index < projects.length; index++) {
    const project = projects[index]!
    const resumeAt = index === state.i && state.p !== undefined ? { p: state.p, h: state.h! } : undefined
    const listing = first !== undefined && index === 0 ? first.listing : new Listing(deps, index, project, "done", floorOf(), resumeAt?.p ?? cutoff, noteUnreachable)
    let buffer: Item[] = first !== undefined && index === 0 ? first.items : []
    let fetched = first !== undefined && index === 0
    for (;;) {
      if (!fetched) {
        if (calls >= LIST_CALLS) return pageOf(deps, owner, scope, collected, refused, state, true, gap, binding)
        buffer = [...buffer, ...(await listing.fetch())]
        calls += 1
      }
      fetched = false
      const complete = listing.done ? buffer : buffer.filter((item) => listing.lowest !== undefined && item.creation > listing.lowest)
      buffer = listing.done ? [] : buffer.filter((item) => listing.lowest === undefined || item.creation <= listing.lowest)
      complete.sort(walkOrder)
      for (const item of complete) {
        if (resumeAt !== undefined && item.creation === resumeAt.p && item.hash <= resumeAt.h) continue
        // A held location's jobs wait for it; one Google reaches again is delivered from its own frontier.
        // A location still dark at this read's start is delivered when it is back, so none of its jobs is taken now.
        const held = entryOf(item.location)
        const waiting = held !== undefined && held[3] !== 1
        const low = held === undefined ? frontier : held[1]
        const already = held !== undefined && item.end !== undefined && deliveredBefore(held, index, item)
        if (!waiting && !already && item.creation <= cutoff && item.end !== undefined && item.end > low) {
          if (item.end <= cutoff) {
            if (!offer(item)) return pageOf(deps, owner, scope, collected, refused, state, true, gap, binding)
          } else {
            // Finished after the cutoff: the next read delivers it, so its floor stays at or below this job.
            state.n = Math.min(state.n, item.creation)
          }
        }
        state.i = index
        state.p = item.creation
        state.h = item.hash
      }
      if (listing.done) break
    }
    // This project is walked: the next starts from the top of the read's range.
    state.i = index + 1
    delete state.p
    delete state.h
  }

  // The read is complete: everything that ended in (e, c] was offered, and a returning location's (its e, c], so the
  // frontier moves to c, returning locations are no longer held, and held ones keep their own frontier and floor.
  const still = dark.filter((entry) => entry[3] !== 1)
  const done: CursorState = {
    e: cutoff,
    f: Math.min(state.n, cutoff),
    ...(still.length > 0 ? { d: still } : {}),
  }
  return pageOf(deps, owner, scope, collected, refused, done, false, gap, binding)
}

/**
 * The start of a read: the jobs still queued or running, Google's now from Google's own answers, and the first page of
 * the walk (kept for the walk, so it costs no extra call).
 *
 * Google's now is the HTTP `Date` of the read's first answer, or, if it carried none, the newest creation or end time
 * the start's answers hold: never the host clock, so no step of the host's clock, forward or back, can move a cutoff
 * past a job Google has not listed yet. The first answer is the one the floor is computed from, so a job created after
 * it is created after the cutoff (the margin covers the start's own calls and listing lag).
 */
async function startRead(
  deps: SourceDeps,
  projects: readonly string[],
  state: CursorState,
  floorOf: () => number,
  noteUnreachable: (index: number, locations: readonly string[]) => void,
): Promise<{ readonly listing: Listing; readonly items: Item[]; readonly googleNow: number | undefined; readonly unfinished: readonly number[]; readonly complete: boolean }> {
  const unfinished: number[] = []
  let complete = true
  let newest: number | undefined
  let firstDate: number | undefined
  const seen = (listing: Listing) => {
    if (firstDate === undefined) firstDate = listing.firstDate
    if (listing.newest !== undefined) newest = newest === undefined ? listing.newest : Math.max(newest, listing.newest)
  }
  // PENDING, then RUNNING: a job moves only forward, so one that moves between the two calls is in one of them, and
  // one that finishes before the walk reaches it is listed DONE there.
  for (const [index, project] of projects.entries()) {
    for (const filter of ["pending", "running"] as const) {
      const listing = new Listing(deps, index, project, filter, floorOf(), undefined, noteUnreachable)
      for (let call = 0; call < UNFINISHED_CALLS && !listing.done; call++) {
        for (const item of await listing.fetch()) unfinished.push(item.creation)
      }
      seen(listing)
      if (!listing.done) complete = false
    }
  }
  const listing = new Listing(deps, 0, projects[0]!, "done", floorOf(), undefined, noteUnreachable)
  const items = await listing.fetch()
  seen(listing)
  return { listing, items, googleNow: firstDate ?? newest, unfinished, complete }
}

/** The contract's page, with this plugin's name on it and the cursor the next call reads from. */
function pageOf(
  deps: SourceDeps,
  owner: EventsOwner,
  scope: Scope | undefined,
  events: readonly SourceEvent[],
  refused: readonly RefusedEvent[],
  state: CursorState,
  more: boolean,
  gap: EventsListResult["gap"],
  binding: Binding,
): EventsListResult {
  // Oldest first on the page; the read as a whole is ordered by its walk, which the cursor carries.
  if (state.d !== undefined && state.d.length > 0) {
    try {
      encodeState(binding, state)
    } catch {
      throw sourceError("UNAVAILABLE", "BigQuery reported more locations unreachable than this source's cursor can hold, so nothing was read.", "Call the source again later with the same cursor; nothing is lost while it waits.")
    }
  }
  const ordered = [...events].sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at) || (left.external_id < right.external_id ? -1 : 1))
  return eventsListResult({ source: "jobs", account: deps.account, owner }, ordered, encodeState(binding, state), more, {
    ...(scope === undefined ? {} : { scope }),
    ...(refused.length > 0 ? { refused } : {}),
    ...(gap === undefined ? {} : { gap }),
    plugin: PACKAGE,
    asOf: iso(deps.ports.clock.now()),
  })
}
