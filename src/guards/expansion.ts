/**
 * Expansion (design §5.1 step 4): the referenced views and routines, recursively to depth 3, so the guards see what a
 * query really reads and what a view's or routine's body really does. The statement type and the referenced lists are
 * BigQuery's own parse of the text that runs; expansion is what follows those lists into the objects they name.
 *
 * A view is read with `tables.get`, and its body is dry-run with the view's own dataset as the default, which gives its
 * base tables in BigQuery's answer rather than by guessing at the text — that is what makes the fence correct whether
 * or not a view's bases appear in the outer query's `referencedTables` (L7). A body that cannot be read, does not lex,
 * cannot be dry-run (an authorised view over tables the caller cannot see), or is legacy SQL is **unresolved**, and the
 * read goes to a plan: nothing is assumed.
 *
 * A routine is read with `routines.get`. A remote function, a Python UDF, a JavaScript UDF or any other non-SQL routine
 * bills or acts outside BigQuery, so it is an external effect. A SQL routine's body is **followed**: every table path
 * after `FROM`/`JOIN` is enqueued and every dotted call is enqueued as a routine, so a TVF that reads a fenced or
 * row-secured table is seen, and a SQL UDF that calls a remote function is an effect (review H-3). A body that cannot
 * be read, does not lex, or names something that does not resolve is unresolved.
 *
 * The top-level text is followed the same way, for the reasons the referenced lists cannot be trusted to carry
 * everything (until L13 says they do). The whole resolution is cached 60 s per account (review R2-L1): a view redefined
 * inside the window is caught after the run by comparing the finished job's referenced lists with what expansion saw
 * (`CLASSIFICATION_DRIFT`).
 */
import { BigQueryError } from "../domain/errors.js"
import type { DatasetReference, DryRunStatistics, RoutineInfo, TableInfo, TableReference } from "../domain/google.js"
import type { Findings, Lexer, Token } from "../domain/lexer-api.js"
import type { Ports } from "../ports.js"
import { rethrowCallFailure } from "./callerrors.js"
import type { TtlCache } from "./cache.js"
import { createLexer, relationNames } from "./lexer.js"
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
  readonly statistics: DryRunStatistics
  /** The top-level text's tokens: the table paths and dotted calls expansion follows itself. */
  readonly tokens?: readonly Token[]
  /** The default dataset a two-part name in the top-level text resolves against, when the call has one. */
  readonly defaultDataset?: DatasetReference
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

/** A dataset a body's two-part names resolve against. */
interface Defaults {
  readonly project: string
  readonly dataset: string
}

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
    // The top-level text names things the lists might not carry: a table function's tables, a UDF's callees.
    if (input.tokens) this.enqueueNames(input.tokens, 1, input.defaultDataset ? { project: input.defaultDataset.projectId, dataset: input.defaultDataset.datasetId } : undefined)

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

  /** The table paths and dotted calls a text names, queued at `depth` (review H-3). */
  private enqueueNames(tokens: readonly Token[], depth: number, defaults: Defaults | undefined): void {
    const names = relationNames(tokens)
    for (const parts of names.tables) {
      if (parts.length === 3) this.tableQueue.push({ ref: { projectId: parts[0]!, datasetId: parts[1]!, tableId: parts[2]! }, depth })
      else if (parts.length >= 4) this.tableQueue.push({ ref: { projectId: parts[0]!, datasetId: parts[1]!, tableId: parts.slice(2).join(".") }, depth })
      else if (defaults) this.tableQueue.push({ ref: { projectId: defaults.project, datasetId: parts[0]!, tableId: parts[1]! }, depth })
      else this.unresolved.add(parts.join("."))
    }
    for (const parts of names.calls) {
      if (parts.length === 3) this.routineQueue.push({ ref: { projectId: parts[0]!, datasetId: parts[1]!, routineId: parts[2]! }, depth })
      else if (defaults) this.routineQueue.push({ ref: { projectId: defaults.project, datasetId: parts[0]!, routineId: parts[1]! }, depth })
      else this.unresolved.add(parts.join("."))
    }
  }

  private async resolveTable(item: { ref: TableReference; depth: number }): Promise<void> {
    const { ref, depth } = item
    // A metadata view is not storage: it has no tables.get answer, and its rows are names, not data.
    if (ref.datasetId.toUpperCase() === "INFORMATION_SCHEMA") return
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
    this.enqueueNames(lexed.tokens, depth + 1, { project: facts.project, dataset: facts.dataset })
    let inner: DryRunStatistics | undefined
    try {
      const answer = await this.deps.ports.bigquery.dryRun(
        {
          account: this.deps.account,
          project: this.deps.project,
          sql: body,
          defaultDataset: { projectId: facts.project, datasetId: facts.dataset },
          ...(facts.location !== undefined ? { location: facts.location } : {}),
        },
        this.deps.signal,
      )
      inner = answer.statistics
    } catch (error) {
      rethrowCallFailure(error)
      inner = undefined
    }
    // A body's own dry run must name a statement type this version knows; no type is DRY_RUN_INCOMPLETE's case.
    if (!inner || (inner.statementType !== "SELECT" && inner.statementType !== "ASSERT")) {
      this.unresolved.add(key)
      return
    }
    this.views.set(key, facts)
    for (const table of inner.referencedTables ?? []) this.tableQueue.push({ ref: table, depth: depth + 1 })
    for (const view of inner.referencedLogicalViews ?? []) this.tableQueue.push({ ref: view, depth: depth + 1 })
    for (const routine of inner.referencedRoutines ?? []) this.routineQueue.push({ ref: routine, depth: depth + 1 })
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
    this.findings.push(this.lexer.findings(lexed.tokens))
    // A SQL routine's body is followed: its tables reach the fence and the cap, and its callees reach the effect check.
    this.enqueueNames(lexed.tokens, depth + 1, { project: ref.projectId, dataset: ref.datasetId })
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
