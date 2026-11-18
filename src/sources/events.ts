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
 * - `c` is Google's now, less a 2-minute settle margin. Google's now comes from Google's own clock: the HTTP `Date` of
 *   its listing answers and the newest creation or end time they hold, less the host time that has passed since the
 *   read started, or the estimate carried from the last read plus the host time since. Only the host clock's rate is
 *   trusted, never its reading, so a host clock ahead of Google's cannot move `c` past a job not yet listed. The
 *   margin covers the lag between a job's end and its listing as DONE.
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
 * **Unreachable locations.** A listing with `unreachable[]` is incomplete for those locations. The read fails with
 * `UNAVAILABLE` and the consumer's cursor waits, which loses nothing. After 7 days of waiting the source goes on
 * without the location and answers a `window-truncated` gap on every read while it stays unreachable; the floor stays
 * where it was (up to a day back), so a job still running there when it comes back is listed once it finishes.
 *
 * **Expiry.** Job history is kept six months. A cursor whose floor is older answers `gap: { reason: "expired" }` once,
 * with the floor raised to what Google still keeps, and reads on. `noExpiry` is false.
 *
 * `title` is the statement type and what was billed, from the listing alone; `text` is empty (a job's SQL holds
 * literals and may hold secrets). Every title passes the contract's secret screen, so a refused job is in `refused[]`
 * with `reason: "secret"`, never in `events[]`.
 */
import { fitPage, makeEvent, parseEventsListInput, screenEvents, startTime, type EventsListResult, type EventsOwner, type RefusedEvent, type Scope, type SourceEvent } from "@we-the-rebel-alliance/source-contract/events"
import { PLUGIN_ID } from "../constants.js"
import { PROJECT_ID } from "../domain/contract.js"
import { formatBytes } from "../guards/cost.js"
import { settingsOf } from "../guards/settings.js"
import type { Options } from "../options.js"
import type { JobStatus, Ports } from "../ports.js"
import type { Call } from "../tool-spec.js"
import { assertSourceReads, JOBS_SOURCE } from "./assert.js"
import { bindingOf, decodeState, encodeState, hashOf, iso, type Binding, type CursorState } from "./cursor.js"
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
/** How long an unreachable location makes the source wait (`UNAVAILABLE`) before it goes on without it. */
export const OUTAGE_HOLD_MS = 7 * DAY
/** At most this many walk calls per `events_list` call. */
export const LIST_CALLS = 20
/** At most this many calls list one project's queued or running jobs when a read starts. */
export const UNFINISHED_CALLS = 10
/** A `jobs.list` page. A full-projection job resource carries its configuration and statistics; 100 keeps it small. */
export const JOBS_PER_CALL = 100
/** The source's declared `maxBytes`, passed to `fitPage`, so a page keeps the size the descriptor promises. */
export const MAX_PAGE_BYTES = 262_144

/** What a source read needs: the ports, the options, the account the registry resolved and the call. */
export interface SourceDeps {
  readonly ports: Ports
  readonly options: Options
  readonly account: string
  readonly call: Call
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
  /** The newest Google timestamp fetched. */
  newest: number | undefined

  constructor(
    private readonly deps: SourceDeps,
    private readonly project: string,
    private readonly state: "done" | "pending" | "running",
    private readonly min: number,
    upper: number | undefined,
    private readonly onUnreachable: (locations: readonly string[]) => void,
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
      this.deps.call.signal,
    )
    if (page.unreachable !== undefined && page.unreachable.length > 0) this.onUnreachable(page.unreachable)
    if (page.serverTime !== undefined) this.newest = this.newest === undefined ? page.serverTime : Math.max(this.newest, page.serverTime)
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
  const identity = await deps.ports.auth.identity(deps.account, deps.call.signal)
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
    const since = startTime(value, hostNow)
    state = { e: since, f: since - LOOKBACK_MS }
  }

  // The source contract's per-operation read, before any Google call: a person's off switch for it is consulted.
  await assertSourceReads(deps, JOBS_SOURCE, ["bigquery.jobs.list"])
  const owner = await ownerOf(deps)

  let gap: Gap | undefined
  const answerGap = (reason: Gap["reason"]) => {
    if (state.g === 1) return
    gap = { reason, since: iso(state.e) }
    state.g = 1
  }

  // History older than six months may be gone. A read in progress that old starts again from its frontier.
  const retained = hostNow - RETENTION_MS
  if (state.f < retained) {
    const answered = state.g === 1
    state = { e: state.e, f: retained, ...(state.t !== undefined ? { t: state.t, u: state.u! } : {}), ...(state.o === 1 ? { o: 1 as const } : {}), ...(answered ? { g: 1 as const } : {}) }
    if (!answered) {
      gap = { reason: "expired", since: iso(state.e) }
      state.g = 1
    }
  }

  // Locations Google skipped. The cursor waits for them (UNAVAILABLE) until the hold has passed.
  let unreachable: readonly string[] = []
  const noteUnreachable = (locations: readonly string[]) => {
    unreachable = [...unreachable, ...locations]
  }
  const settleOutage = () => {
    if (unreachable.length === 0) return
    if (state.o !== 1 && hostNow - state.e <= OUTAGE_HOLD_MS) {
      throw sourceError(
        "UNAVAILABLE",
        `BigQuery reported ${locationWords(unreachable)} unreachable, so the list of jobs is incomplete and nothing was read.`,
        "Call the source again later with the same cursor; nothing is lost while it waits.",
        { retryAfterSec: 300 },
      )
    }
    state.o = 1
    answerGap("window-truncated")
  }

  let first: { readonly listing: Listing; readonly items: Item[] } | undefined
  if (state.c === undefined) {
    first = await startRead(deps, projects, state, hostNow, noteUnreachable, answerGap)
    // A read whose start reaches every location is out of any outage; one that does not keeps the outage's state.
    if (unreachable.length === 0) delete state.o
  }
  if (state.c === undefined || state.n === undefined || state.i === undefined) throw new Error("bigquery.jobs: a read started without its cutoff")
  settleOutage()

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
      actors: [{ role: "author", id: owner.id, ...(owner.label !== undefined ? { name: owner.label } : {}) }],
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
    const listing = first !== undefined && index === 0 ? first.listing : new Listing(deps, project, "done", state.f, resumeAt?.p ?? cutoff, noteUnreachable)
    let buffer: Item[] = first !== undefined && index === 0 ? first.items : []
    let fetched = first !== undefined && index === 0
    for (;;) {
      if (!fetched) {
        if (calls >= LIST_CALLS) return pageOf(deps, owner, scope, collected, refused, state, true, gap, binding)
        buffer = [...buffer, ...(await listing.fetch())]
        calls += 1
        settleOutage()
      }
      fetched = false
      const complete = listing.done ? buffer : buffer.filter((item) => listing.lowest !== undefined && item.creation > listing.lowest)
      buffer = listing.done ? [] : buffer.filter((item) => listing.lowest === undefined || item.creation <= listing.lowest)
      complete.sort(walkOrder)
      for (const item of complete) {
        if (resumeAt !== undefined && item.creation === resumeAt.p && item.hash <= resumeAt.h) continue
        if (item.creation <= cutoff && item.end !== undefined && item.end > frontier) {
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

  // The read is complete: everything that ended in (e, c] was offered, so the frontier moves to c. While a location is
  // down its running jobs are not listed, so the floor stays (up to a day back) for them to be found once it is back.
  const next = Math.min(state.n, cutoff)
  const done: CursorState = {
    e: cutoff,
    f: Math.max(state.o === 1 ? Math.min(next, Math.max(state.f, cutoff - LOOKBACK_MS)) : next, state.f),
    ...(state.t !== undefined ? { t: state.t, u: state.u! } : {}),
    ...(state.o === 1 ? { o: 1 as const } : {}),
  }
  return pageOf(deps, owner, scope, collected, refused, done, false, gap, binding)
}

/**
 * The start of a read: the jobs still queued or running, Google's now from Google's own timestamps, the cutoff, the
 * next floor, and the first page of the walk (kept for the walk, so it costs no extra call).
 */
async function startRead(
  deps: SourceDeps,
  projects: readonly string[],
  state: CursorState,
  hostNow: number,
  noteUnreachable: (locations: readonly string[]) => void,
  answerGap: (reason: Gap["reason"]) => void,
): Promise<{ readonly listing: Listing; readonly items: Item[] }> {
  const unfinished: number[] = []
  let complete = true
  let newest: number | undefined
  const stamp = (value: number | undefined) => {
    if (value !== undefined) newest = newest === undefined ? value : Math.max(newest, value)
  }
  // PENDING, then RUNNING: a job moves only forward, so one that moves between the two calls is in one of them, and
  // one that finishes before the walk reaches it is listed DONE there.
  for (const project of projects) {
    for (const filter of ["pending", "running"] as const) {
      const listing = new Listing(deps, project, filter, state.f, undefined, noteUnreachable)
      for (let call = 0; call < UNFINISHED_CALLS && !listing.done; call++) {
        for (const item of await listing.fetch()) unfinished.push(item.creation)
      }
      stamp(listing.newest)
      if (!listing.done) complete = false
    }
  }
  const listing = new Listing(deps, projects[0]!, "done", state.f, undefined, noteUnreachable)
  const items = await listing.fetch()
  stamp(listing.newest)
  const received = deps.ports.clock.now()

  // Google's now when the read started, at least: a timestamp Google listed, less the host time that has passed since
  // the read started (the listing calls); or the carried one, plus the host time since it was seen.
  const estimates: number[] = []
  if (newest !== undefined) estimates.push(newest - Math.max(0, received - hostNow))
  if (state.t !== undefined && state.u !== undefined) estimates.push(state.t + Math.max(0, hostNow - state.u))
  const googleNow = estimates.length > 0 ? Math.max(...estimates) : undefined
  const cutoff = googleNow === undefined ? state.e : Math.max(state.e, googleNow - SETTLE_MS)

  // The next floor: below every job still queued or running (tracked for a day after its creation), never above the
  // cutoff. A listing too long to finish leaves the floor where it is, which only costs a longer walk.
  let next = cutoff
  let untracked = false
  if (!complete) next = state.f
  else {
    for (const creation of unfinished) {
      if (creation < cutoff - LOOKBACK_MS) untracked = true
      else next = Math.min(next, creation)
    }
  }
  if (untracked) answerGap("window-truncated")

  if (googleNow !== undefined) {
    state.t = googleNow
    state.u = hostNow
  }
  state.c = cutoff
  state.n = Math.max(next, state.f)
  state.i = 0
  delete state.p
  delete state.h
  return { listing, items }
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
  const ordered = [...events].sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at) || (left.external_id < right.external_id ? -1 : 1))
  return {
    source: "jobs",
    account: deps.account,
    owner,
    events: ordered,
    cursor: encodeState(binding, state),
    more,
    trust: "untrusted",
    ...(scope !== undefined ? { scope: canonicalOf(scope) } : {}),
    ...(refused.length > 0 ? { refused: [...refused] } : {}),
    ...(gap !== undefined ? { gap } : {}),
    plugin: PLUGIN_ID,
    asOf: iso(deps.ports.clock.now()),
  }
}

/** The scope in canonical form, as the contract's result carries it: keys sorted, lists sorted without repeats. */
function canonicalOf(scope: Scope): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of Object.keys(scope).sort()) {
    const value = scope[key]!
    out[key] = typeof value === "string" ? value : [...new Set(value)].sort()
  }
  return out
}
