/**
 * Expansion (design §5.1 step 4): the views and routines BigQuery's dry run names, recursively to depth 3, so the guards
 * see what a query really reads and what a view's or routine's body really does.
 *
 * **BigQuery's answer is the only source of what a statement touches.** The top-level dry run's `referencedTables`,
 * `referencedLogicalViews` and `referencedRoutines` are Google's parse of the exact text that runs, so no alias, join,
 * comma or quoting form can hide a table from them (review bigquery-3 R-1, R-2: every local parse missed one). Google's
 * Job resource documents each list only as "Referenced tables for the job" (and the like), and does not say whether a
 * view's base tables or a routine body's tables are in the outer list; so every view and SQL routine reached is
 * analysed by a dry run of its own body, and what that dry run names is followed in turn:
 *
 * - a view: `tables.get` → `view.query`, dry-run with the view's dataset as the default;
 * - a SQL function: `routines.get` → `definitionBody`, dry-run as `routineProbeSql` builds it (its arguments as typed
 *   `NULL`s), with the routine's dataset as the default;
 * - a remote function, a Python, JavaScript or any other non-SQL routine bills or acts outside BigQuery: an external
 *   effect, and nothing to follow;
 * - a property graph: this version does not follow a graph to its node and edge tables, so it is unresolved.
 *
 * Each body is also lexed, for what no referenced list names: built-in calls that act or bill outside BigQuery
 * (`ML.*`, `AI.*`, `EXTERNAL_QUERY`, `OBJ.GET_ACCESS_URL`). A body that cannot be read, does not lex, cannot be dry-run
 * (an authorised view or routine over tables the caller cannot see), answers with a statement type other than
 * `SELECT`, or is legacy SQL is **unresolved**, and the read goes to a plan: nothing is assumed.
 *
 * The whole resolution is cached 60 s per account (review R2-L1): a view redefined inside the window is caught after the
 * run by comparing the finished job's referenced lists with what expansion saw (`CLASSIFICATION_DRIFT`).
 */
import { BigQueryError } from "../domain/errors.js"
import type { DatasetReference, DryRunStatistics, RoutineInfo, TableInfo, TableReference } from "../domain/google.js"
import type { Findings, Lexer } from "../domain/lexer-api.js"
import type { Ports } from "../ports.js"
import { rethrowCallFailure } from "./callerrors.js"
import type { TtlCache } from "./cache.js"
import { createLexer } from "./lexer.js"
import { routineProbeSql } from "./routinebody.js"
import { tableFacts, type TableFacts } from "./tables.js"

/** How deep a view or routine chain may go (design §5.1 step 4). */
export const MAX_DEPTH = 3

export interface ExpansionDeps {
  readonly ports: Ports
  readonly account: string
  /** The job's project, for the view and routine bodies' two-part names and their dry runs. */
  readonly project: string
  readonly signal: AbortSignal
  readonly location?: string
  readonly tables: TtlCache<TableInfo>
  readonly routines: TtlCache<RoutineInfo>
  readonly lexer?: Lexer
}

export interface ExpansionInput {
  /** The top-level dry run's statistics: its referenced lists are where expansion starts. */
  readonly statistics: DryRunStatistics
}

export interface ExpansionResult {
  /** Every stored table reached: the dry run's own references, every view's bases, and every routine's tables. */
  readonly tables: readonly TableFacts[]
  readonly views: readonly TableFacts[]
  readonly routines: readonly RoutineInfo[]
  /** The findings of every expanded body, in the order they were read. */
  readonly findings: readonly Findings[]
  /** Effects a routine adds: a remote function, a Python or JavaScript UDF, another non-SQL routine. */
  readonly effects: readonly string[]
  /** The view and routine paths expansion saw, for the post-run drift comparison. */
  readonly seenViews: ReadonlySet<string>
  readonly seenRoutines: ReadonlySet<string>
  /** Validated names of references that could not be resolved; any of them sends the read to a plan. */
  readonly unresolved: readonly string[]
}

const keyOf = (ref: TableReference) => `${ref.projectId}.${ref.datasetId}.${ref.tableId}`
const routineKey = (ref: { readonly projectId: string; readonly datasetId: string; readonly routineId: string }) => `${ref.projectId}.${ref.datasetId}.${ref.routineId}`

/**
 * A metadata view, not storage: it has no `tables.get` answer and its rows are names, not data. Google does not document
 * how a dry run names one, so any part spelled `INFORMATION_SCHEMA` (or a `region-` qualifier) counts; an allow fence
 * checks these from the text (`informationSchemaRefs`).
 */
export function isInformationSchema(ref: TableReference): boolean {
  if (/^region-/i.test(ref.projectId) || /^region-/i.test(ref.datasetId)) return true
  return [ref.datasetId, ...ref.tableId.split(".")].some((part) => part.toUpperCase() === "INFORMATION_SCHEMA")
}

/** The statistics a body's own dry run must carry for it to count as analysed. */
type BodyAnswer = { readonly ok: true; readonly statistics: DryRunStatistics } | { readonly ok: false }

export class Expander {
  private readonly lexer: Lexer
  private readonly tableQueue: { ref: TableReference; depth: number }[] = []
  private readonly routineQueue: { ref: { projectId: string; datasetId: string; routineId: string }; depth: number }[] = []
  private readonly tables = new Map<string, TableFacts>()
  private readonly views = new Map<string, TableFacts>()
  private readonly routines = new Map<string, RoutineInfo>()
  private readonly findings: Findings[] = []
  private readonly effects = new Set<string>()
  private readonly unresolved = new Set<string>()
  private readonly seenViews = new Set<string>()
  private readonly seenRoutines = new Set<string>()

  constructor(private readonly deps: ExpansionDeps) {
    this.lexer = deps.lexer ?? createLexer()
  }

  async expand(input: ExpansionInput): Promise<ExpansionResult> {
    // One expander may serve several calls; each starts from nothing.
    for (const map of [this.tables, this.views, this.routines]) map.clear()
    for (const set of [this.effects, this.unresolved, this.seenViews, this.seenRoutines]) set.clear()
    this.findings.length = 0
    this.tableQueue.length = 0
    this.routineQueue.length = 0

    for (const ref of input.statistics.referencedTables ?? []) this.tableQueue.push({ ref, depth: 1 })
    for (const ref of input.statistics.referencedLogicalViews ?? []) this.tableQueue.push({ ref, depth: 1 })
    for (const ref of input.statistics.referencedRoutines ?? []) this.routineQueue.push({ ref, depth: 1 })
    this.graphs(input.statistics)

    // One queue at a time, either kind: a routine's body queues tables, and a view's body queues routines.
    while (this.tableQueue.length > 0 || this.routineQueue.length > 0) {
      const table = this.tableQueue.shift()
      if (table) {
        await this.resolveTable(table)
        continue
      }
      await this.resolveRoutine(this.routineQueue.shift()!)
    }

    return {
      tables: [...this.tables.values()],
      views: [...this.views.values()],
      routines: [...this.routines.values()],
      findings: this.findings,
      effects: [...this.effects],
      seenViews: this.seenViews,
      seenRoutines: this.seenRoutines,
      unresolved: [...this.unresolved],
    }
  }

  /** What a body's own dry run names, queued one level deeper. */
  private enqueueAnswer(statistics: DryRunStatistics, depth: number): void {
    for (const table of statistics.referencedTables ?? []) this.tableQueue.push({ ref: table, depth })
    for (const view of statistics.referencedLogicalViews ?? []) this.tableQueue.push({ ref: view, depth })
    for (const routine of statistics.referencedRoutines ?? []) this.routineQueue.push({ ref: routine, depth })
    this.graphs(statistics)
  }

  /** A property graph reads node and edge tables this version does not follow: unresolved, so the read needs a plan. */
  private graphs(statistics: DryRunStatistics): void {
    for (const graph of statistics.referencedPropertyGraphs ?? []) this.unresolved.add(`${graph.projectId}.${graph.datasetId}.${graph.propertyGraphId}`)
  }

  /**
   * A body's own dry run, with its object's dataset as the default (so its two-part names resolve as BigQuery resolves
   * them for that object). Only a `SELECT` with statistics counts as analysed; a refusal for this body alone is
   * `{ ok: false }`, and a call-wide failure (signed out, quota, Google down) ends the call.
   */
  private async bodyDryRun(sql: string, dataset: DatasetReference, location: string | undefined): Promise<BodyAnswer> {
    let statistics: DryRunStatistics | undefined
    try {
      const answer = await this.deps.ports.bigquery.dryRun(
        {
          account: this.deps.account,
          project: this.deps.project,
          sql,
          defaultDataset: dataset,
          ...(location !== undefined ? { location } : {}),
          // A cached answer need not list what it read (INFORMATION_SCHEMA.JOBS: the referenced lists are "only
          // populated for query jobs that are not cache hits"), so the cache is never consulted for an analysis.
          useQueryCache: false,
        },
        this.deps.signal,
      )
      statistics = answer.statistics
    } catch (error) {
      rethrowCallFailure(error)
      return { ok: false }
    }
    // A body's own dry run must name a statement type this version reads; no type is DRY_RUN_INCOMPLETE's case.
    if (!statistics || statistics.statementType !== "SELECT") return { ok: false }
    return { ok: true, statistics }
  }

  private async resolveTable(item: { ref: TableReference; depth: number }): Promise<void> {
    const { ref, depth } = item
    if (isInformationSchema(ref)) return
    const key = keyOf(ref)
    if (this.tables.has(key) || this.views.has(key)) return
    let info: TableInfo
    try {
      info = await this.table(ref)
    } catch (error) {
      rethrowCallFailure(error)
      this.unresolved.add(key)
      return
    }
    const facts = tableFacts(info)
    if (facts.kind !== "view") {
      this.tables.set(key, facts)
      return
    }
    this.seenViews.add(key)
    if (depth > MAX_DEPTH) {
      this.unresolved.add(key)
      return
    }
    const body = info.view?.query
    if (!body) {
      this.unresolved.add(key)
      return
    }
    // A legacy-SQL view body is not GoogleSQL: this version does not analyse it, so the read needs a plan.
    if (info.view?.useLegacySql === true) {
      this.unresolved.add(key)
      return
    }
    const lexed = this.lexer.lex(body)
    if (!lexed.ok) {
      this.unresolved.add(key)
      return
    }
    this.findings.push(this.lexer.findings(lexed.tokens))
    const answer = await this.bodyDryRun(body, { projectId: facts.project, datasetId: facts.dataset }, facts.location)
    if (!answer.ok) {
      this.unresolved.add(key)
      return
    }
    this.views.set(key, facts)
    this.enqueueAnswer(answer.statistics, depth + 1)
  }

  private async resolveRoutine(item: { ref: { projectId: string; datasetId: string; routineId: string }; depth: number }): Promise<void> {
    const { ref, depth } = item
    const key = routineKey(ref)
    if (this.seenRoutines.has(key)) return
    let routine: RoutineInfo
    try {
      routine = await this.routine(ref)
    } catch (error) {
      rethrowCallFailure(error)
      this.unresolved.add(key)
      return
    }
    this.seenRoutines.add(key)
    this.routines.set(key, routine)
    if (depth > MAX_DEPTH) {
      this.unresolved.add(key)
      return
    }

    // A remote function has no SQL body of its own; its endpoint is the effect, and the caller's own request is what
    // reaches it.
    if (routine.remoteFunctionOptions !== undefined) {
      this.effects.add("a remote function")
      return
    }
    const language = (routine.language ?? "SQL").toUpperCase()
    if (language === "PYTHON") {
      this.effects.add("a Python UDF")
      return
    }
    if (language === "JAVASCRIPT") {
      this.effects.add("a JavaScript UDF")
      return
    }
    if (language !== "SQL") {
      // Anything else this version does not know fails closed too.
      this.effects.add("a non-SQL routine")
      return
    }

    const body = routine.definitionBody
    if (body === undefined || body.trim() === "") {
      this.unresolved.add(key)
      return
    }
    const lexed = this.lexer.lex(body)
    if (!lexed.ok) {
      this.unresolved.add(key)
      return
    }
    // The lexer reads the body only for built-in calls with external effects; what it reads comes from BigQuery.
    this.findings.push(this.lexer.findings(lexed.tokens))
    const probe = routineProbeSql(routine, this.lexer)
    if (probe === undefined) {
      this.unresolved.add(key)
      return
    }
    const answer = await this.bodyDryRun(probe, { projectId: ref.projectId, datasetId: ref.datasetId }, this.deps.location)
    if (!answer.ok) {
      this.unresolved.add(key)
      return
    }
    this.enqueueAnswer(answer.statistics, depth + 1)
  }

  /** A view or routine by path, or the plugin's own error. */
  private table(ref: TableReference): Promise<TableInfo> {
    const key = `${this.deps.account}|${keyOf(ref)}`
    const cached = this.deps.tables.get(key)
    if (cached) return Promise.resolve(cached)
    return this.deps.ports.bigquery
      .getTable(this.deps.account, ref, this.deps.signal)
      .then((info) => this.deps.tables.set(key, info))
      .catch((error: unknown) => {
        if (error instanceof BigQueryError) throw error
        throw new BigQueryError("UNAVAILABLE", `The table ${keyOf(ref)} could not be read`)
      })
  }

  private routine(ref: { readonly projectId: string; readonly datasetId: string; readonly routineId: string }): Promise<RoutineInfo> {
    const key = `${this.deps.account}|${routineKey(ref)}`
    const cached = this.deps.routines.get(key)
    if (cached) return Promise.resolve(cached)
    return this.deps.ports.bigquery
      .getRoutine(this.deps.account, ref, this.deps.signal)
      .then((routine) => this.deps.routines.set(key, routine))
      .catch((error: unknown) => {
        if (error instanceof BigQueryError) throw error
        throw new BigQueryError("UNAVAILABLE", `The routine ${routineKey(ref)} could not be read`)
      })
  }
}
