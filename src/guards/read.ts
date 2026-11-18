/**
 * The read path (design §5.1) for `bigquery_query`, `bigquery_profile`, `bigquery_search`, `bigquery_table`'s
 * partitions and `bigquery_saved_read` (package E calls the same two functions).
 *
 * `prepareRead` does steps 1–8 and throws the refusal the read deserves; `runRead` does step 9 and the post-run checks.
 * Every step fails closed: a statement BigQuery does not call a read refuses, a reference that cannot be resolved, an
 * external effect, an object outside the fence and any cap condition this version cannot prove all answer
 * `NEEDS_PLAN`, and nothing reaches `jobs.insert` before the dry run has answered with the statistics the guards need.
 *
 * **What decides what.** BigQuery's dry run is the only source of the objects a statement touches: its
 * `referencedTables`, `referencedLogicalViews`, `referencedRoutines` and `referencedPropertyGraphs`, and the same lists
 * from a dry run of every view and SQL routine body they lead to (`Expander`). That server set decides the fence, the
 * per-table assert, the policy-tag rule, the cap's storage and row-policy conditions and the account's `inline.deny`.
 * The lexer decides only what no referenced list carries:
 * - local refusals: a text that does not lex (`SQL_INVALID`), a `#legacySQL` hint (`LEGACY_SQL_REFUSED`);
 * - raising the statement's kind (`CALL`, `EXECUTE IMMEDIATE`, transactions, destructive wording), never lowering it;
 * - built-in calls that act or bill outside BigQuery (`ML.*`, `AI.*`, `EXTERNAL_QUERY`, `OBJ.GET_ACCESS_URL`), in the
 *   text and in every expanded body;
 * - a temporary function's definition, whose body no server list is documented to cover: refused;
 * - a region- or project-level `INFORMATION_SCHEMA` view under an allow fence: refused;
 * - the hints.
 * Text over 1 MiB is refused by the schema. A dry run that fails, or answers without `statistics.query` or a statement
 * type, refuses (`DRY_RUN_INCOMPLETE`): no read runs on the lexer's word alone.
 *
 * The dry run never consults the query cache: Google's `INFORMATION_SCHEMA.JOBS` reference says the referenced lists are
 * "only populated for query jobs that are not cache hits", and an empty list must never pass for "reads nothing". The run
 * itself may still use the cache.
 *
 * The run reuses the exact text and parameters, carries a client `jobId`, `maximumBytesBilled`, labels and a time limit,
 * and no destination, session or connection properties. A finished job is compared with its dry run
 * (`CLASSIFICATION_DRIFT`).
 */
import { BigQueryError, type ErrorCode } from "../domain/errors.js"
import { actionOf } from "../domain/actions.js"
import { tableResource } from "../domain/accounts.js"
import type { Accuracy, DatasetReference, DryRunStatistics, QueryParameter, TableInfo, RoutineInfo } from "../domain/google.js"
import { path } from "../domain/identifiers.js"
import type { Findings, Token } from "../domain/lexer-api.js"
import { kindOf, raise, type Kind, type StatementType } from "../domain/statements.js"
import type { Options } from "../options.js"
import type { JobStatus, Ports, ResultPage } from "../ports.js"
import { cacheOf } from "./cache.js"
import { asCallError } from "./callerrors.js"
import { capVerdict, type CapVerdict } from "./cap.js"
import { capAndBudget, usdFor, type Warning } from "./cost.js"
import { Expander, MAX_DEPTH, MAX_EXPANDED, type ExpansionResult } from "./expansion.js"
import { rowGate } from "./rows.js"
import { assertFenced, isFenced, type FenceObject } from "./fence.js"
import { hintsFor } from "./hints.js"
import { failureFor } from "./jobfail.js"
import { createLexer, definesFunction, hasKeyword, informationSchemaRefs } from "./lexer.js"
import { limiterFor } from "./limits.js"
import { toQueryParameters } from "./params.js"
import { policyVerdict, type PolicyVerdict } from "./policy.js"
import { shapeRows, type ResultColumn, type ShapedRows } from "./results.js"
import { RowPolicyProber, type RowVerdict } from "./rowpolicy.js"
import { sessionHash } from "./session.js"
import { locationOf, projectOf, settingsOf, type AccountSettings } from "./settings.js"
import type { TableFacts } from "./tables.js"
import type { Call } from "../tool-spec.js"

/** What a read needs besides its own input: the ports, the account, the call and the tool it is running for. */
export interface ReadContext {
  readonly ports: Ports
  readonly options: Options
  readonly account: string
  readonly settings: AccountSettings
  readonly sessionID: string
  readonly signal: AbortSignal
  /** The tool, for the `oc_tool` label: `bigquery_query`, `bigquery_profile`, `saved_read`. */
  readonly via: string
  /** The tool's action, which the per-table assert names (design §5.4). */
  readonly action: string
  /** The call, for the per-table assert: `<account>:table:<project>.<dataset>.<name>` for every referenced object. */
  readonly call: Call
}

export function readContext(input: {
  readonly ports: Ports
  readonly options: Options
  readonly account: string
  readonly call: Call
  readonly via: string
}): ReadContext {
  const tool = input.via.startsWith("bigquery_") ? input.via.slice("bigquery_".length) : input.via
  return {
    ports: input.ports,
    options: input.options,
    account: input.account,
    settings: settingsOf(input.options, input.account),
    sessionID: input.call.sessionID,
    signal: input.call.signal,
    via: input.via,
    action: actionOf(tool).action,
    call: input.call,
  }
}

export interface ReadRequest {
  readonly sql: string
  readonly params?: Readonly<Record<string, unknown>> | readonly unknown[]
  readonly project?: string
  readonly location?: string
  readonly maxBytes?: number
  /** A view or function body's default dataset, for a statement written without one. */
  readonly defaultDataset?: DatasetReference
  readonly useCache?: boolean
}

/** What the guards learned before anything ran. */
export interface PreparedRead {
  readonly sql: string
  readonly params?: readonly QueryParameter[]
  /** The project the job runs in and bills to. */
  readonly project: string
  /** The location the dry run chose; the run is pinned to it. */
  readonly location: string
  readonly statementType: StatementType
  readonly kind: Kind
  readonly statistics: DryRunStatistics
  readonly bytes: number
  readonly accuracy?: Accuracy
  readonly tables: readonly TableFacts[]
  readonly views: readonly TableFacts[]
  readonly routines: readonly RoutineInfo[]
  readonly findings: readonly Findings[]
  readonly effects: readonly string[]
  readonly cap: CapVerdict
  readonly policy: PolicyVerdict
  readonly hints: readonly string[]
  readonly usd: number
  readonly useCache: boolean
  readonly maxBytes?: number
  readonly defaultDataset?: DatasetReference
  /** Validated names of references expansion could not resolve. */
  readonly unresolved: readonly string[]
}

export type PrepareMode = "read" | "inspect"

/** The name a temporary function is recorded under among a plan's unresolved references. */
export const TEMPORARY_FUNCTION = "a temporary function"

const lexRefusal = (line: number, column: number, what: string) =>
  new BigQueryError("SQL_INVALID", `The lexer found ${what} at line ${line}, column ${column}`, "Fix the SQL at that position; bigquery_table shows the names.")

/** Steps 1–8 of §5.1. Throws the refusal; never returns a statement that has not passed every guard. */
export async function prepareRead(context: ReadContext, request: ReadRequest, mode: PrepareMode): Promise<PreparedRead> {
  const lexer = createLexer()
  const lexed = lexer.lex(request.sql)
  if (!lexed.ok) throw lexRefusal(lexed.error.line, lexed.error.column, lexed.error.what)
  const top = lexer.findings(lexed.tokens)
  if (top.dialectHint === "legacy") {
    throw new BigQueryError("LEGACY_SQL_REFUSED", "The query asks for legacy SQL with a #legacySQL hint", "Rewrite it in GoogleSQL.")
  }

  const params = toQueryParameters(request.params)
  const project = projectOf(context.settings, request.project)
  const location = locationOf(context.settings, request.location)
  const useCache = request.useCache ?? true
  assertWideInformationSchema(context.settings.fence, lexed.tokens)

  let answer: { readonly location: string; readonly statistics?: DryRunStatistics }
  try {
    answer = await context.ports.bigquery.dryRun(
      {
        account: context.account,
        project,
        sql: request.sql,
        ...(params ? { params } : {}),
        ...(request.defaultDataset ? { defaultDataset: request.defaultDataset } : {}),
        ...(location !== undefined ? { location } : {}),
        // Never a cached answer: a cache hit need not list what it read (see the header).
        useQueryCache: false,
      },
      context.signal,
    )
  } catch (error) {
    throw asCallError(error, "The dry run did not answer")
  }

  const statistics = answer.statistics
  if (!statistics || statistics.statementType === undefined) {
    throw new BigQueryError(
      "DRY_RUN_INCOMPLETE",
      "The dry run answered without statistics.query or without a statement type, so the statement cannot be checked",
      "Retry once; if it repeats, report it, because no read can run without these checks.",
    )
  }
  const tableKind = kindOf(statistics.statementType)
  if (tableKind === undefined) {
    throw new BigQueryError("STATEMENT_UNKNOWN", `BigQuery parsed the SQL as ${plain(statistics.statementType)}, which this version does not classify`, "Run it in the Google Cloud console or with bq, and update the plugin.")
  }
  const kind = raise(tableKind, top.raisesTo)
  const bytes = Number(statistics.totalBytesProcessed ?? "0")

  // Step 3 before step 4: a change or a script is refused here, before any metadata read, so a plan preview is the only
  // way to look further at it.
  if (mode === "read" && kind !== "read") {
    throw new BigQueryError(
      "STATEMENT_NOT_READ",
      `BigQuery parsed the SQL as ${plain(statistics.statementType)}, and this tool runs only SELECT and ASSERT`,
      "Call bigquery_plan({ sql }) and show the user the preview, then call the commit tool it names.",
    )
  }

  const now = () => context.ports.clock.now()
  // The dry run's own lists are fenced before anything they name is read (review bigquery-3 round 3, LOW 6): a fenced view
  // or routine's metadata and body are never touched. The full set is fenced again after expansion.
  assertFenced(context.settings.fence, fenceObjects(statistics, EMPTY_EXPANSION))

  const expander = new Expander({
    ports: context.ports,
    account: context.account,
    project,
    signal: context.signal,
    location: answer.location,
    tables: cacheOf<TableInfo>(context.ports.clock, "expand.tables", 60_000, now),
    routines: cacheOf<RoutineInfo>(context.ports.clock, "expand.routines", 60_000, now),
    lexer,
  })
  let expansion: ExpansionResult
  try {
    expansion = await expander.expand({ statistics })
  } catch (error) {
    throw asCallError(error, "The references could not be resolved")
  }

  // The fence comes first among the refusals that follow expansion: an object outside it is refused outright, never
  // offered a plan. §5.4's second fence: a person's own rule names every referenced object, so `deny bigquery.query on
  // work:table:*.hr.*` is consulted too.
  const objects = fenceObjects(statistics, expansion)
  assertFenced(context.settings.fence, objects)
  await assertObjectResourcesFor(context, objects)

  const findings: Findings[] = [top, ...expansion.findings]
  const effects = [...new Set([...top.externalEffects, ...expansion.findings.flatMap((report) => report.externalEffects), ...expansion.effects])]
  // A temporary function is not a persisted routine: no `routines.get` reads it, and Google does not say the referenced
  // lists cover its body. Its body is not parsed here; the read fails closed instead.
  const temporary = definesFunction(lexed.tokens)
  const unresolved = temporary ? [TEMPORARY_FUNCTION, ...expansion.unresolved] : expansion.unresolved

  if (mode === "read") {
    if (temporary) {
      throw new BigQueryError(
        "NEEDS_PLAN",
        "The query defines a temporary function, and what a temporary function's body reads cannot be checked before it runs",
        "Write the expression inline, or call a persistent function (its body is checked); otherwise show the user the preview after bigquery_plan({ sql }), which needs a Read and write sign-in.",
        { reason: "UNRESOLVED_REFERENCE" },
      )
    }
    if (expansion.limit !== undefined) {
      throw new BigQueryError(
        "NEEDS_PLAN",
        `The query's references were not all checked: ${expansion.limit} (at most ${MAX_EXPANDED} views and routines, ${MAX_DEPTH} deep, are expanded for one read)`,
        "Show the user the preview after bigquery_plan({ sql }), which needs a Read and write sign-in, or split the query so each part reads fewer objects.",
        { reason: "UNRESOLVED_REFERENCE" },
      )
    }
    if (expansion.unresolved.length > 0) {
      throw new BigQueryError(
        "NEEDS_PLAN",
        `The query references ${safeName(expansion.unresolved[0]!)}, which could not be resolved (a view or routine deeper than 3, a body BigQuery's dry run could not analyse, or a property graph)`,
        "Show the user the preview after bigquery_plan({ sql }); a Read account needs a Read and write sign-in for this one, or rewrite the query to avoid that object.",
        { reason: "UNRESOLVED_REFERENCE" },
      )
    }
    if (effects.length > 0) {
      throw new BigQueryError(
        "NEEDS_PLAN",
        `The query has external effects: ${effects.join(", ")}`,
        "Show the user the preview after bigquery_plan({ sql }); these bill or act outside the byte cap and need a Read and write account.",
        { reason: "EXTERNAL_EFFECTS" },
      )
    }
  }

  const prober = new RowPolicyProber(
    { ports: context.ports, account: context.account, project, signal: context.signal },
    cacheOf<RowVerdict>(context.ports.clock, "rowpolicy", 10 * 60_000, now),
  )
  const cap = await capVerdict({ statistics, bytes, tables: expansion.tables, effects, unresolved, rowPolicy: (facts) => prober.probe(facts) })

  if (mode === "read" && !cap.enforceable) {
    if (context.options.uncappedReads === "refuse") {
      throw new BigQueryError(
        "CAP_NOT_ENFORCEABLE",
        `The byte cap cannot bound this query: ${cap.whyNot ?? "an unknown condition"}`,
        "Narrow the query to native tables without row access policies, or ask the user to set uncappedReads to ask.",
      )
    }
    throw new BigQueryError(
      "NEEDS_PLAN",
      `The byte cap cannot bound this query: ${cap.whyNot ?? "an unknown condition"}`,
      "Call bigquery_plan({ sql }), show the user the preview, and with their go-ahead run bigquery_query({ planId }).",
      { reason: "CAP_NOT_ENFORCEABLE" },
    )
  }

  const policy = policyVerdict({ tables: [...expansion.tables, ...expansion.views], mode: context.options.policyTagged })
  const hints = hintsFor({ findings: top, tables: expansion.tables, bytes, hasLimit: hasKeyword(lexed.tokens, "LIMIT"), useCache })

  return {
    sql: request.sql,
    ...(params ? { params } : {}),
    project,
    location: answer.location,
    statementType: statistics.statementType as StatementType,
    kind,
    statistics,
    bytes,
    ...(statistics.totalBytesProcessedAccuracy ? { accuracy: statistics.totalBytesProcessedAccuracy } : {}),
    tables: expansion.tables,
    views: expansion.views,
    routines: expansion.routines,
    findings,
    effects,
    cap,
    policy,
    hints,
    usd: usdFor(bytes, context.options),
    useCache,
    ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
    ...(request.defaultDataset ? { defaultDataset: request.defaultDataset } : {}),
    unresolved,
  }
}

export interface RunInput {
  readonly maxRows: number
  readonly waitSeconds: number
  /** The plan's cap, for an uncapped-read plan; the call's own `maxBytes` otherwise. */
  readonly maxBytes?: number
  /** The job's time limit; the read's own, or the shorter one a cap-unenforceable read gets. */
  readonly timeoutSeconds?: number
}

export interface RunFailure {
  readonly code: ErrorCode
  readonly detail: string
  readonly next?: string
}

/** Everything a finished or running read answers with. */
export interface ReadRun {
  readonly state: "done" | "running" | "failed"
  readonly job: { readonly project: string; readonly jobId: string; readonly location: string }
  readonly status: JobStatus
  readonly page?: ResultPage
  readonly columns?: readonly ResultColumn[]
  readonly rows?: readonly (readonly unknown[])[]
  readonly totalRows?: number
  readonly returned?: number
  readonly truncated?: ShapedRows["truncated"]
  /** False when rows were withheld from the model: the policy-tag rule or the account's inline option. */
  readonly inline?: boolean
  readonly warnings: readonly Warning[]
  readonly bytesBilled: number
  readonly bytesProcessed: number
  readonly cacheHit: boolean
  readonly usd: number
  readonly failure?: RunFailure
}

/** Step 9 of §5.1: the cap and budget, the run, the page, the drift check and the ledger. */
export async function runRead(context: ReadContext, prepared: PreparedRead, input: RunInput): Promise<ReadRun> {
  const now = context.ports.clock.now()
  const session = sessionHash(context.sessionID)
  const budget = await capAndBudget({
    options: context.options,
    ports: context.ports,
    account: context.account,
    session,
    now,
    estimateBytes: prepared.bytes,
    ...(input.maxBytes !== undefined ? { requested: input.maxBytes } : prepared.maxBytes !== undefined ? { requested: prepared.maxBytes } : {}),
  })
  if (prepared.bytes > budget.capBytes) {
    throw new BigQueryError(
      "COST_CAP",
      `The estimate is ${prepared.bytes} bytes and the cap is ${budget.capBytes} bytes${budget.remainingBytes !== undefined ? ` (the budget leaves ${budget.remainingBytes})` : ""}`,
      `Narrow the query, or pass maxBytes up to the account's maxBytesCeiling of ${context.options.maxBytesCeiling} bytes.`,
    )
  }

  const timeoutSeconds = Math.max(1, Math.min(input.timeoutSeconds ?? context.options.jobTimeoutSeconds, 21_600))
  const jobId = `oc_${context.ports.clock.uuid()}`
  const labels = { oc_plugin: "opencode-bigquery", oc_tool: labelOf(context.via), oc_session: session }
  const limiter = limiterFor(context.ports.clock, context.account, context.options.maxConcurrentJobs)

  let status: JobStatus
  try {
    status = await limiter.run(context.signal, () =>
      context.ports.bigquery.run(
        {
          account: context.account,
          project: prepared.project,
          sql: prepared.sql,
          ...(prepared.params ? { params: prepared.params } : {}),
          ...(prepared.defaultDataset ? { defaultDataset: prepared.defaultDataset } : {}),
          location: prepared.location,
          useQueryCache: prepared.useCache,
          jobId,
          maximumBytesBilled: budget.capBytes,
          jobTimeoutMs: timeoutSeconds * 1000,
          labels,
        },
        context.signal,
      ),
    )
  } catch (error) {
    throw asCallError(error, "The query job did not start")
  }

  // A job this process started is remembered by id, so `bigquery_job` can reuse the text-aware verdict instead of
  // failing closed on every tagged table (review H-1).
  rememberJob(context.ports.clock, context.account, status.ref.jobId, prepared)

  const bytesBilled = status.totalBytesBilled ?? 0
  const job = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? prepared.location }
  const record = async (billed: number) => {
    if (billed <= 0) return
    try {
      await context.ports.ledger.record({
        at: new Date(status.endTime ?? context.ports.clock.now()).toISOString(),
        account: context.account,
        project: prepared.project,
        location: prepared.location,
        jobId: job.jobId,
        bytesBilled: billed,
        via: context.via,
        session,
      })
    } catch {
      // The query already ran and billed; a ledger write that fails must not hide its result. The next call's budget
      // check is the loser, by at most this one job.
    }
  }

  const failure = failureFor(status)
  if (failure) {
    await record(bytesBilled)
    throw failure
  }

  const base = {
    job,
    status,
    warnings: [...budget.warnings],
    bytesBilled,
    bytesProcessed: status.totalBytesProcessed ?? prepared.bytes,
    cacheHit: status.cacheHit === true,
    usd: usdFor(bytesBilled, context.options),
  }

  let page: ResultPage | undefined
  try {
    page = await context.ports.bigquery.results(context.account, status.ref, { timeoutMs: Math.max(0, input.waitSeconds) * 1000, maxResults: input.maxRows + 1 }, context.signal)
  } catch (error) {
    await record(bytesBilled)
    throw asCallError(error, "The job's results could not be read")
  }
  if (!page.complete) {
    return { state: "running", ...base }
  }
  await record(bytesBilled)

  const drift = driftOf(prepared, status)
  if (drift !== undefined) {
    dropExpansionCaches(context.ports)
    return {
      state: "failed",
      ...base,
      page,
      failure: {
        code: "CLASSIFICATION_DRIFT",
        detail: drift,
        next: "bigquery_jobs shows what ran; report it, and run the query again after the object settles.",
      },
    }
  }

  const shaped = shapeRows({
    schema: page.schema ?? prepared.statistics.schema?.fields,
    rows: page.rows,
    maxRows: input.maxRows,
    maxInlineBytes: context.options.maxInlineBytes,
  })

  const warnings = [...base.warnings]
  if (prepared.accuracy === "LOWER_BOUND") {
    warnings.push({ code: "ESTIMATE_LOWER_BOUND", message: "The dry run's estimate is a lower bound, so what is billed may be more." })
  }
  const gate = rowGate({ options: context.options, account: context.account, settings: context.settings, tables: [...prepared.tables, ...prepared.views], policy: prepared.policy })
  warnings.push(...gate.warnings)

  return {
    ...base,
    state: "done",
    page,
    inline: gate.inline,
    columns: shaped.columns,
    rows: gate.inline ? shaped.rows : [],
    totalRows: page.totalRows ?? page.rows.length,
    returned: gate.inline ? shaped.returned : 0,
    truncated: shaped.truncated,
    warnings,
  }
}

/**
 * The `next` a save-only result answers with: `bigquery_save` on the job, whose result table is the only copy of the
 * rows. The job and location are validated identifiers; the path is the caller's to choose.
 */
export function saveNext(job: { readonly project: string; readonly jobId: string; readonly location: string }): string {
  return `bigquery_save({ project: ${plain(job.project)}, jobId: ${plain(job.jobId)}, location: ${plain(job.location)}, path: "results.jsonl", format: "jsonl" })`
}

/**
 * Why the run differs from its dry run, or undefined.
 *
 * TODO(L7, L13): whether a query's `referencedTables` already lists a view's base tables and a routine body's tables is
 * the live check's question; expansion does not depend on it, because it dry-runs each body itself.
 */
function driftOf(prepared: PreparedRead, status: JobStatus): string | undefined {
  if (status.statementType !== undefined && status.statementType !== prepared.statementType) {
    return `The job ran as ${plain(status.statementType)}, and its dry run parsed it as ${prepared.statementType}`
  }
  const fresh: string[] = []
  for (const ref of status.referencedLogicalViews ?? []) {
    const key = `${ref.projectId}.${ref.datasetId}.${ref.tableId}`
    if (!prepared.views.some((facts) => facts.name === key)) fresh.push(key)
  }
  for (const ref of status.referencedRoutines ?? []) {
    const key = `${ref.projectId}.${ref.datasetId}.${ref.routineId}`
    if (!prepared.routines.some((routine) => `${routine.routineReference.projectId}.${routine.routineReference.datasetId}.${routine.routineReference.routineId}` === key)) fresh.push(key)
  }
  if (fresh.length === 0) return undefined
  return `The job referenced ${safeName(fresh[0]!)}, which expansion did not see`
}

function dropExpansionCaches(ports: Ports): void {
  cacheOf<TableInfo>(ports.clock, "expand.tables", 60_000, Date.now).clear()
  cacheOf<RoutineInfo>(ports.clock, "expand.routines", 60_000, Date.now).clear()
}

// ── the jobs this process started, for `bigquery_job`'s reuse of a text-aware verdict ────────────────────────────

const jobVerdicts = new WeakMap<object, Map<string, PreparedRead>>()
const MAX_JOBS = 64

export function rememberJob(owner: object, account: string, jobId: string, prepared: PreparedRead): void {
  let perOwner = jobVerdicts.get(owner)
  if (!perOwner) {
    perOwner = new Map()
    jobVerdicts.set(owner, perOwner)
  }
  perOwner.set(`${account}|${jobId}`, prepared)
  while (perOwner.size > MAX_JOBS) {
    const oldest = perOwner.keys().next().value
    if (oldest === undefined) break
    perOwner.delete(oldest)
  }
}

export function jobVerdict(owner: object, account: string, jobId: string): PreparedRead | undefined {
  return jobVerdicts.get(owner)?.get(`${account}|${jobId}`)
}

/**
 * §5.4's second fence: the tool's own action asserted again with every referenced object as a resource
 * (`<account>:table:<project>.<dataset>.<name>`), so a person's OpenCode rule fences too (review M-2).
 */
export async function assertObjectResources(
  input: { readonly call: Call; readonly account: string; readonly action: string; readonly via: string; readonly objects: readonly FenceObject[] },
): Promise<void> {
  if (input.objects.length === 0) return
  const resources = [...new Set(input.objects.map((object) => tableResource(input.account, object.project, object.dataset, object.name)))]
  await input.call.assert({
    action: input.action,
    resources,
    metadata: { account: input.account, tool: input.via, objects: input.objects.length },
  })
}

/** The per-table assert through a read context. */
async function assertObjectResourcesFor(context: ReadContext, objects: readonly FenceObject[]): Promise<void> {
  await assertObjectResources({ call: context.call, account: context.account, action: context.action, via: context.via, objects })
}

/**
 * An allow fence cannot confine a region- or project-level `INFORMATION_SCHEMA` view: it names every dataset in the
 * region or project, and Google's dry run need not list any fenced object for it (review LOW 1). A dataset-qualified
 * one is allowed only when its dataset is inside the fence. Deny-only fences are unchanged.
 */
function assertWideInformationSchema(fence: AccountSettings["fence"], tokens: readonly Token[]): void {
  if (fence?.allow === undefined) return
  for (const ref of informationSchemaRefs(tokens)) {
    if (ref.level === "dataset") {
      const [project, dataset] = ref.parts
      if (project !== undefined && dataset !== undefined && !isFenced(fence, { project, dataset, name: "INFORMATION_SCHEMA", kind: "view" })) continue
    }
    throw new BigQueryError(
      "DATASET_FENCED",
      "The query reads a region- or project-level INFORMATION_SCHEMA view, which an allow fence cannot confine",
      "Use bigquery_search, which filters its matches through the fence, or ask the user to change the account's datasets option.",
    )
  }
}

/** An expansion that reached nothing, for fencing the dry run's own lists before expanding them. */
const EMPTY_EXPANSION: ExpansionResult = { tables: [], views: [], routines: [], findings: [], effects: [], seenViews: new Set(), seenRoutines: new Set(), unresolved: [] }

/** Every object the fence judges: the dry run's four lists, then everything expansion reached. */
function fenceObjects(statistics: DryRunStatistics, expansion: ExpansionResult): FenceObject[] {
  const out: FenceObject[] = []
  const seen = new Set<string>()
  const add = (kind: string, project: string, dataset: string, name: string) => {
    const key = `${kind}|${project}|${dataset}|${name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, project, dataset, name })
  }
  for (const ref of statistics.referencedTables ?? []) add("table", ref.projectId, ref.datasetId, ref.tableId)
  for (const ref of statistics.referencedLogicalViews ?? []) add("view", ref.projectId, ref.datasetId, ref.tableId)
  for (const ref of statistics.referencedRoutines ?? []) add("routine", ref.projectId, ref.datasetId, ref.routineId)
  for (const ref of statistics.referencedPropertyGraphs ?? []) add("property graph", ref.projectId, ref.datasetId, ref.propertyGraphId)
  for (const facts of expansion.tables) add(facts.kind === "view" ? "view" : "table", facts.project, facts.dataset, facts.table)
  for (const facts of expansion.views) add("view", facts.project, facts.dataset, facts.table)
  for (const routine of expansion.routines) {
    const ref = routine.routineReference
    add("routine", ref.projectId, ref.datasetId, ref.routineId)
  }
  return out
}

/** A dotted path from expansion, each part validated; anything else is "an object". */
function safeName(dotted: string): string {
  const parts = dotted.split(".")
  if (parts.length === 3) return path(parts[0]!, parts[1]!, parts[2]!)
  if (parts.length === 2) return path(parts[0]!, parts[1]!)
  return "an object"
}

/** A value in a `next` or `message`: a plain identifier, in backquotes when it is one, otherwise `object`. */
function plain(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`"
}

/** A label value: lowercase letters, digits, underscores and dashes, at most 63. */
function labelOf(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63) || "tool"
}
