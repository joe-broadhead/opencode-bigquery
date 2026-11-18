/**
 * `bigquery.jobs`, the plugin's events source (design §10): one event per finished job the signed-in person started,
 * from `jobs.list` (`allUsers: false`, `stateFilter: done`, `projection: FULL`), which is free and keeps six months of
 * job history, newest first (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/list).
 *
 * **Paging: a window of creation time, read whole.** `jobs.list` filters on creation time inclusively
 * (`minCreationTime`, `maxCreationTime`) and pages newest first, so a page here is built from one creation-time window
 * `[f, e]`, every page of it, up to `LIST_CALLS` calls — or not at all (`atomicPages`, design §10). The window is
 * carved out of the contract's oldest-first page: candidates are sorted by **end** time (a job's `occurred_at`) and cut
 * at `limit`; `p` in the cursor continues the same window without repeating one. When a walk hits its call cap, the
 * fetched prefix is complete for everything created **after** its oldest creation `b`, so that part is delivered and
 * `[f, b]` becomes the next window (or `q` remembers it while a page cut by `limit` drains). No job is skipped: the
 * frontier never moves past a window that was not read.
 *
 * **Late arrivals: a 24 h lookback, de-duplicated by time.** A query can run six hours, and Google retries it for up to
 * 18 ([19] in the design); a job created within the lookback but still running at read time is listed by the next read.
 * Every read therefore starts at `w − 24 h` (the previous window's end), and skips a job whose **end** time is at or
 * before `w`: it was DONE when that window was read, so it was listed then. A job that finished after `w` was not
 * listed, so it is listed now. This is exact, and unlike a list of emitted ids it needs no room in the contract's
 * 1,024-character cursor. It is also the same rule for the lookback and for repeated reads: one frontier, checked once.
 *
 * **The three bugs the family's reviews keep finding.**
 * - *the sliding gap*: a page that cannot carry a window's older jobs carries that window's **floor** in the cursor
 *   (`f`/`q`) and reads it next; no line is ever recomputed from "now";
 * - *the jam*: a burst of jobs ending in one millisecond is walked by `(occurred_at, id hash)` through `p`, so a burst
 *   larger than a page drains once each;
 * - *a gap once per read*: a gap is written on the page that discovers it, and the cursor it answers with names a
 *   window that cannot produce the same gap again.
 *
 * **Expiry.** Job history is kept six months. A cursor whose window end is older answers a page with
 * `gap: { reason: "expired" }` and a fresh cursor, once; the next read is an ordinary one. `noExpiry` is false.
 *
 * `title` is the statement type and what was billed, built from the listing alone; `text` is empty (a job's SQL holds
 * literals and may hold secrets, and the design keeps it out). Every title passes the contract's secret screen, so a
 * refused job appears in `refused[]` with `reason: "secret"` and never in `events[]`.
 */
import { fitPage, makeEvent, parseEventsListInput, screenEvents, startTime, type EventsListResult, type EventsOwner, type RefusedEvent, type Scope, type SourceEvent } from "@we-the-rebel-alliance/source-contract/events"
import { PLUGIN_ID } from "../constants.js"
import { PROJECT_ID } from "../domain/contract.js"
import { formatBytes } from "../guards/cost.js"
import { settingsOf } from "../guards/settings.js"
import type { Options } from "../options.js"
import type { JobStatus, Ports } from "../ports.js"
import type { Call } from "../tool-spec.js"
import { bindingOf, decodeState, encodeState, hashOf, iso, type Binding, type CursorState, type Position } from "./cursor.js"
import { sourceError } from "./errors.js"

/** The lookback before the previous window's end: longer than a query's 6 h runtime with retries to 18 h (design §10). */
export const LOOKBACK_MS = 24 * 3_600_000
/** Six months of job history (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/list). */
export const RETENTION_MS = 180 * 86_400_000
/** At most this many `jobs.list` calls build one project's page (design §10, L1). */
export const LIST_CALLS = 10
/** A `jobs.list` page. A full-projection job resource carries its configuration and statistics; 100 keeps an answer small. */
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

interface Candidate {
  readonly id: string
  readonly creation?: number
  readonly end: number
  readonly project: string
  readonly jobId: string
  readonly location: string
  readonly statementType?: string
  readonly billed?: number
  readonly ocTool?: string
}

/** One window's walk: the jobs it found, and what is left of it. */
interface Walked {
  readonly candidates: readonly Candidate[]
  readonly truncated: boolean
  /** The oldest creation time fetched, when the walk was cut short. */
  readonly boundary?: number
  /** The listing token the cap stopped at, for a window that cannot be narrowed (one project only). */
  readonly token?: string
}

/** The owner every page names: the signed-in account, by its address when Google reports one. */
async function ownerOf(deps: SourceDeps): Promise<EventsOwner> {
  const identity = await deps.ports.auth.identity(deps.account, deps.call.signal)
  const email = identity.email
  return email !== undefined ? { id: `mailto:${email}`, label: email } : { id: `bigquery:account:${deps.account}`, label: `BigQuery account ${deps.account}` }
}

/** The projects a page reads: the confirmed scope's, or the account's billing project. */
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
  const projects = [...new Set(values.map(String))]
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

/** One `jobs.list` walk of `[from, to]` per project, newest first, up to the call cap. */
async function walk(deps: SourceDeps, projects: readonly string[], from: number, to: number, token: string | undefined): Promise<Walked> {
  const candidates: Candidate[] = []
  let nextToken: string | undefined
  let boundary: number | undefined
  for (const project of projects) {
    let pageToken = projects.length === 1 ? token : undefined
    let calls = 0
    let remaining: string | undefined
    do {
      const page = await deps.ports.bigquery.listJobs(
        {
          account: deps.account,
          project,
          stateFilter: "done",
          minCreationTime: from,
          maxCreationTime: to,
          maxResults: JOBS_PER_CALL,
          ...(pageToken === undefined ? {} : { pageToken }),
        },
        deps.call.signal,
      )
      calls += 1
      for (const status of page.items) {
        const candidate = candidateOf(status, project)
        if (candidate !== undefined) candidates.push(candidate)
      }
      pageToken = page.nextPageToken
      remaining = page.nextPageToken
      if (calls >= LIST_CALLS && remaining !== undefined) break
    } while (remaining !== undefined)
    if (remaining !== undefined) {
      nextToken = remaining
      const oldest = candidates.filter((candidate) => candidate.project === project && candidate.creation !== undefined).map((candidate) => candidate.creation!)
      const oldestOfProject = oldest.length > 0 ? Math.min(...oldest) : to
      boundary = boundary === undefined ? oldestOfProject : Math.min(boundary, oldestOfProject)
    }
  }
  const truncated = nextToken !== undefined
  return {
    candidates,
    truncated,
    ...(truncated && boundary !== undefined ? { boundary } : {}),
    // One project's token can continue one listing; with several projects there is no single listing to resume.
    ...(truncated && nextToken !== undefined && projects.length === 1 ? { token: nextToken } : {}),
  }
}

/** A finished job as a candidate: DONE with an end time, as the contract's `occurred_at` needs one. */
function candidateOf(status: JobStatus, project: string): Candidate | undefined {
  if (status.state !== "DONE" || status.endTime === undefined) return undefined
  const location = status.ref.location ?? ""
  return {
    id: `${status.ref.projectId}:${location}:${status.ref.jobId}`,
    ...(status.creationTime !== undefined ? { creation: status.creationTime } : {}),
    end: status.endTime,
    project: status.ref.projectId || project,
    jobId: status.ref.jobId,
    location,
    ...(status.statementType !== undefined ? { statementType: status.statementType } : {}),
    ...(status.totalBytesBilled !== undefined ? { billed: status.totalBytesBilled } : {}),
    ...(status.labels?.oc_tool !== undefined ? { ocTool: status.labels.oc_tool } : {}),
  }
}

/**
 * A job's console link. The link's project and `j` parameters are the console's own; the job id is the fully qualified
 * one the console lists (`my-project-1234:US.bquijob_…`, "Manage jobs"), which is why the location is on the link too.
 */
function consoleUrl(candidate: Candidate): string | null {
  if (!PROJECT_ID.test(candidate.project)) return null
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(candidate.jobId)) return null
  const location = /^[A-Za-z0-9-]{2,64}$/.test(candidate.location) ? `&location=${encodeURIComponent(candidate.location)}` : ""
  return `https://console.cloud.google.com/bigquery?project=${encodeURIComponent(candidate.project)}&j=${encodeURIComponent(candidate.jobId)}&page=job_details${location}`
}

/** The title, from the listing alone: the statement type and what was billed. The type is provider text: a new enum
 * value, or an odd answer, must reach the contract's secret screen rather than be assumed safe. */
function titleOf(candidate: Candidate): string {
  const type = candidate.statementType !== undefined && candidate.statementType.length > 0 ? candidate.statementType.slice(0, 64) : "Job"
  return candidate.billed === undefined ? type : `${type} — ${formatBytes(candidate.billed)} billed`
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
  const now = deps.ports.clock.now()
  const limit = Math.min(value.limit ?? 100, 500)
  const owner = await ownerOf(deps)
  const binding = bindingOf(deps.account, scope)

  let state: CursorState
  let continuing = false
  if (value.cursor !== undefined) {
    const decoded = decodeState(binding, value.cursor)
    if (!decoded.ok) throw sourceError("CURSOR_INVALID", decoded.what, "Start again with since, or pass the cursor with the source, account and scope it was issued for.")
    state = decoded.state
    if (state.w < now - RETENTION_MS) return expiredPage(deps, owner, binding, scope, state.w)
    continuing = state.f !== undefined && state.e !== undefined
  } else {
    const from = startTime(value, now)
    if (from < now - RETENTION_MS) return expiredPage(deps, owner, binding, scope, from)
    // A first read covers its `since` (or the contract's 24 h), and its high-water mark is that window's end.
    state = { w: now, f: from, e: now }
    continuing = true
  }

  // A new window (not a continuation) starts a lookback before the last window's end, and it is a lookback chain: every
  // job it lists that ended at or before that end was DONE when the previous chain read it, so it was listed then, and
  // it is skipped on every page of this chain (not only the first). The cursor's `w` is the chain's **top**: the end of
  // the window the chain began with, even after it has drained older parts of it. That is what keeps a later lookback
  // from re-listing the newer part (its jobs ended after the older part's end, so a frontier left there would not skip
  // them). A first read has no earlier chain and so no frontier.
  const frontier = !continuing || state.k === 1 ? state.w : undefined
  const from = continuing ? state.f! : Math.max(state.w - LOOKBACK_MS, now - RETENTION_MS)
  const to = continuing ? state.e! : now
  if (!continuing) state = { w: to, f: from, e: to, k: 1 }
  const lookback = state.k === 1 ? ({ k: 1 } as const) : {}
  const carriedPosition = continuing ? state.p : undefined
  const carriedToken = continuing ? state.t : undefined
  const owed = continuing ? state.q : undefined

  const walked = await walk(deps, projects, from, to, carriedToken)
  const boundary = walked.boundary
  // A truncated walk is complete for everything created after its oldest fetched creation: that is the deliverable
  // part. The rest of the window is owed (`[from, boundary]`), and is read next rather than skipped.
  const narrowed = walked.truncated && boundary !== undefined && boundary > from && boundary < to
  const winFrom = narrowed ? boundary + 1 : from
  const winTo = to

  const candidates = walked.candidates
    .filter((candidate) => (candidate.creation ?? winTo) >= winFrom && (candidate.creation ?? winTo) <= winTo)
    .filter((candidate) => frontier === undefined || candidate.end > frontier)
    .filter((candidate) => !positionBefore(candidate, carriedPosition))
    .sort((left, right) => (left.end === right.end ? (hashOf(left.id) < hashOf(right.id) ? -1 : 1) : left.end - right.end))

  const built = candidates.map((candidate) =>
    makeEvent({
      source: "jobs",
      account: deps.account,
      external_id: candidate.id,
      kind: "x-bigquery/job" as never,
      occurred_at: candidate.end,
      title: titleOf(candidate),
      text: "",
      url: consoleUrl(candidate),
      labels: [candidate.statementType, "DONE", candidate.ocTool].filter((label): label is string => typeof label === "string" && label.length > 0),
      actors: [{ role: "author", id: owner.id, ...(owner.label !== undefined ? { name: owner.label } : {}) }],
    }),
  )
  const screened = screenEvents(built, { ownedBy: () => true })
  const take = fitPage(screened.events, limit, MAX_PAGE_BYTES)
  const events = screened.events.slice(0, take)
  const cut = screened.events.length > events.length
  const last = events[events.length - 1]
  const position: Position | undefined = cut && last !== undefined ? { e: Date.parse(last.occurred_at), h: hashOf(last.external_id) } : undefined

  let next: CursorState
  let more: boolean
  let gap: EventsListResult["gap"]
  if (cut) {
    if (walked.truncated && !narrowed) {
      // A window this source cannot narrow (one creation millisecond, more than ten pages) that also overflows the
      // page: say from where its history is missing and end the chain; the token cannot help a page cut by limit.
      more = false
      next = { w: state.w }
      gap = { reason: "window-truncated", since: iso(owed ?? from) }
    } else {
      more = true
      next = { w: state.w, ...lookback, f: winFrom, e: winTo, ...(narrowed ? { q: from } : owed !== undefined ? { q: owed } : {}), p: position }
    }
  } else if (narrowed) {
    // The newer part is delivered whole; the older part `[from, boundary]` is the next window, carried by its floor.
    more = true
    next = { w: state.w, ...lookback, f: from, e: boundary }
  } else if (owed !== undefined) {
    // A page cut by limit has drained the newer part; the floor carried with it is the older part.
    more = true
    next = { w: state.w, ...lookback, f: owed, e: winFrom - 1 }
  } else if (walked.truncated) {
    if (walked.token !== undefined) {
      // The window cannot be narrowed, and this page holds its whole fetched prefix: the token names the rest.
      more = true
      next = { w: state.w, ...lookback, f: from, e: to, t: walked.token }
    } else {
      more = false
      next = { w: state.w }
      gap = { reason: "window-truncated", since: iso(owed ?? from) }
    }
  } else {
    // The chain is complete: the high-water mark is the chain's top, not the end of the last (possibly older) window it
    // read. A job created between that top and this page is outside the chain, and its end is after the mark, so the
    // next chain lists it; a job that ended at or before the top was listed by the chain, so the lookback skips it.
    more = false
    next = { w: state.w }
  }

  return pageOf(deps, owner, scope, events, screened.refused, next, more, gap, binding)
}

/** Whether a candidate is at or before a window position: already delivered by a previous page of the same window. */
function positionBefore(candidate: Candidate, position: Position | undefined): boolean {
  if (position === undefined) return false
  if (candidate.end !== position.e) return candidate.end < position.e
  return hashOf(candidate.id) <= position.h
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
  return {
    source: "jobs",
    account: deps.account,
    owner,
    events: [...events],
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

/**
 * A cursor or a `since` older than the six months BigQuery keeps: say where history was lost, and answer a cursor that
 * restarts from now. The page is empty and `more` is false, so the gap cannot repeat on its next page.
 */
function expiredPage(deps: SourceDeps, owner: EventsOwner, binding: Binding, scope: Scope | undefined, since: number): EventsListResult {
  return pageOf(deps, owner, scope, [], [], { w: deps.ports.clock.now() }, false, { reason: "expired", since: iso(since) }, binding)
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
