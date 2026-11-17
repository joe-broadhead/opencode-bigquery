/**
 * Expansion (design §5.1 step 4): the referenced views and routines, recursively to depth 3, so the guards see what a
 * query really reads and what a view's or routine's body really does. The statement type and the referenced lists are
 * BigQuery's own parse of the text that runs; expansion is what follows those lists into the objects they name.
 *
 * A view is read with `tables.get` and its body is dry-run with the view's own dataset as the default, which gives its
 * base tables in BigQuery's answer rather than by guessing at the text — that is what makes the fence correct whether
 * or not a view's bases appear in the outer query's `referencedTables` (L7). A body that cannot be read, does not lex,
 * cannot be dry-run (an authorised view over tables the caller cannot see), or is legacy SQL is **unresolved**, and the
 * read goes to a plan: nothing is assumed.
 *
 * A routine is read with `routines.get`: a remote function or a Python UDF bills and acts outside BigQuery, so it is an
 * external effect; a SQL body is lexed for the same findings as the top-level text. Anything deeper than depth 3 is
 * unresolved.
 *
 * The whole resolution is cached 60 s per account (review R2-L1): a view redefined inside the window is caught after
 * the run by comparing the finished job's referenced lists with what expansion saw (`CLASSIFICATION_DRIFT`).
 */
import { BigQueryError } from "../domain/errors.js"
import type { DryRunStatistics, RoutineInfo, TableInfo, TableReference } from "../domain/google.js"
import type { Findings, Lexer } from "../domain/lexer-api.js"
import type { Ports } from "../ports.js"
import type { TtlCache } from "./cache.js"
import { rethrowCallFailure } from "./callerrors.js"
import { createLexer } from "./lexer.js"
import { tableFacts, type TableFacts } from "./tables.js"

/** How deep a view or routine chain may go (design §5.1 step 4). */
export const MAX_DEPTH = 3

export interface ExpansionDeps {
  readonly ports: Ports
  readonly account: string
  /** The job's project, for the view bodies' dry runs. */
  readonly project: string
  readonly signal: AbortSignal
  readonly location?: string
  readonly tables: TtlCache<TableInfo>
  readonly routines: TtlCache<RoutineInfo>
  readonly lexer?: Lexer
}

export interface ExpansionResult {
  /** Every stored table reached: the dry run's own references and every view's bases. */
  readonly tables: readonly TableFacts[]
  readonly views: readonly TableFacts[]
  readonly routines: readonly RoutineInfo[]
  /** The findings of every expanded body, in the order they were read. */
  readonly findings: readonly Findings[]
  /** Effects a routine adds: a remote function, a Python UDF. */
  readonly effects: readonly string[]
  /** The view and routine paths expansion saw, for the post-run drift comparison. */
  readonly seenViews: ReadonlySet<string>
  readonly seenRoutines: ReadonlySet<string>
  /** Validated names of references that could not be resolved; any of them sends the read to a plan. */
  readonly unresolved: readonly string[]
}

const keyOf = (ref: TableReference) => `${ref.projectId}.${ref.datasetId}.${ref.tableId}`
const routineKey = (ref: { readonly projectId: string; readonly datasetId: string; readonly routineId: string }) => `${ref.projectId}.${ref.datasetId}.${ref.routineId}`

export class Expander {
  private readonly lexer: Lexer

  constructor(private readonly deps: ExpansionDeps) {
    this.lexer = deps.lexer ?? createLexer()
  }

  async expand(statistics: DryRunStatistics): Promise<ExpansionResult> {
    const tables = new Map<string, TableFacts>()
    const views = new Map<string, TableFacts>()
    const routines = new Map<string, RoutineInfo>()
    const findings: Findings[] = []
    const effects = new Set<string>()
    const unresolved = new Set<string>()
    const seenViews = new Set<string>()
    const seenRoutines = new Set<string>()

    const tableQueue: { ref: TableReference; depth: number }[] = []
    const routineQueue: { ref: { projectId: string; datasetId: string; routineId: string }; depth: number }[] = []
    const enqueueTables = (list: readonly TableReference[] | undefined, depth: number) => {
      for (const ref of list ?? []) tableQueue.push({ ref, depth })
    }
    enqueueTables(statistics.referencedTables, 1)
    enqueueTables(statistics.referencedLogicalViews, 1)
    // TODO(L13): whether an outer dry run lists a routine a view's body uses, and whether it lists transitive bases at
    // all. C does not rely on it: each view's own dry run is what expands its references.
    for (const ref of statistics.referencedRoutines ?? []) routineQueue.push({ ref, depth: 1 })

    while (tableQueue.length > 0) {
      const { ref, depth } = tableQueue.shift()!
      const key = keyOf(ref)
      if (tables.has(key) || views.has(key)) continue
      let info: TableInfo
      try {
        info = await this.table(ref)
      } catch (error) {
        rethrowCallFailure(error)
        unresolved.add(key)
        continue
      }
      const facts = tableFacts(info)
      if (facts.kind !== "view") {
        tables.set(key, facts)
        continue
      }
      seenViews.add(key)
      if (depth > MAX_DEPTH) {
        unresolved.add(key)
        continue
      }
      const body = info.view?.query
      if (!body) {
        unresolved.add(key)
        continue
      }
      // A legacy-SQL view body is not GoogleSQL: this version does not analyse it, so the read needs a plan.
      if (info.view?.useLegacySql === true) {
        unresolved.add(key)
        continue
      }
      const lexed = this.lexer.lex(body)
      if (!lexed.ok) {
        unresolved.add(key)
        continue
      }
      findings.push(this.lexer.findings(lexed.tokens))
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
      if (!inner || (inner.statementType !== undefined && inner.statementType !== "SELECT" && inner.statementType !== "ASSERT")) {
        unresolved.add(key)
        continue
      }
      views.set(key, facts)
      enqueueTables(inner.referencedTables, depth + 1)
      enqueueTables(inner.referencedLogicalViews, depth + 1)
      for (const routine of inner.referencedRoutines ?? []) routineQueue.push({ ref: routine, depth: depth + 1 })
    }

    while (routineQueue.length > 0) {
      const { ref, depth } = routineQueue.shift()!
      const key = routineKey(ref)
      if (seenRoutines.has(key)) continue
      let routine: RoutineInfo
      try {
        routine = await this.routine(ref)
      } catch (error) {
        rethrowCallFailure(error)
        unresolved.add(key)
        continue
      }
      seenRoutines.add(key)
      routines.set(key, routine)
      if (depth > MAX_DEPTH) {
        unresolved.add(key)
        continue
      }
      if (routine.remoteFunctionOptions !== undefined) effects.add("a remote function")
      const language = (routine.language ?? "SQL").toUpperCase()
      if (language === "PYTHON") effects.add("a Python UDF")
      // A SQL body is lexed for the same findings as the top-level text; another language's syntax is not SQL.
      if (language === "SQL" && routine.definitionBody) {
        const lexed = this.lexer.lex(routine.definitionBody)
        if (!lexed.ok) unresolved.add(key)
        else findings.push(this.lexer.findings(lexed.tokens))
      }
    }

    return {
      tables: [...tables.values()],
      views: [...views.values()],
      routines: [...routines.values()],
      findings,
      effects: [...effects],
      seenViews,
      seenRoutines,
      unresolved: [...unresolved],
    }
  }

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
