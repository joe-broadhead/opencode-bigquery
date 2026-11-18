/**
 * `bigquery_plan` (design §5.2): steps 1–2 and 4–7 of §5.1 through package C's `prepareRead` in `inspect` mode, then the
 * classification of design §5.2, the preview a person reads, and a single-use plan.
 *
 * **Classification comes from BigQuery's dry run**, never from a parse of the SQL: `statementType` picks the kind
 * (`src/domain/statements.ts`), and the lexer may only raise it (a `MERGE` with `DELETE`, `OR REPLACE`, `DROP` in
 * `ALTER`, expiration options, `LOAD DATA OVERWRITE`, `CALL`, `EXECUTE IMMEDIATE`). A plain side-effect-free `SELECT` the
 * cap can bound is refused here (`CATEGORY_MISMATCH`: it runs through `bigquery_query`); one the cap cannot bound is an
 * `uncapped-read` plan (Q13) unless the account refuses those; a read with external effects or unresolved references is
 * a `write` plan, because a Read account must not run it. The objects a change affects come from the dry run's own DDL,
 * DCL and DML fields (`src/changes/statistics.ts`), never from a `FROM`-clause parse.
 *
 * Nothing runs: the dry run and the metadata reads are free, and the plan is in memory. On a Read account the preview is
 * still returned, with `committable: false`, so the person can see what a Read and write sign-in would do.
 */
import { type Category } from "../domain/actions.js"
import { BigQueryError } from "../domain/errors.js"
import type { OutputOf } from "../domain/contract.js"
import { commitCall, type Plan, type PlanPreview, type PlannedStatement } from "../domain/plans.js"
import { type Token } from "../domain/lexer-api.js"
import type { Options } from "../options.js"
import { parseBytes } from "../options.js"
import type { HandlerContext, Handlers } from "../registry.js"
import { isFenced } from "../guards/fence.js"
import { capAndBudget, usdFor } from "../guards/cost.js"
import { createLexer, significantTokens } from "../guards/lexer.js"
import { prepareRead, readContext, type PreparedRead } from "../guards/read.js"
import { cacheOf } from "../guards/cache.js"
import { RowPolicyProber, type RowVerdict } from "../guards/rowpolicy.js"
import { sessionHash } from "../guards/session.js"
import type { Fence } from "../guards/settings.js"
import { boundSentence } from "./bounds.js"
import { changeStatistics, targetsOf, type Target } from "./statistics.js"

/** The default job limit for a script: 300 s unless the caller passes a lower one (design §5.2). */
const SCRIPT_TIMEOUT_SECONDS = 300

/** A byte size from the input: a number, or a string such as `1GiB`. */
const bytesOf = (value: string | number) => (typeof value === "number" ? value : parseBytes(value))

export interface ClassifyInput {
  /** The plan's `maxBytes`; a script requires one. */
  readonly requestedBytes?: number
  readonly jobTimeoutSeconds?: number
  /** The person's reason, for an admin plan. */
  readonly reason?: string
}

export interface Classification {
  readonly category: Category
  readonly capEnforceable: boolean
  readonly jobTimeoutSeconds: number
}

/**
 * Design §5.2's one table: a statement type (already raised by the lexer) to a category, or a refusal. The lexer can
 * only make this stricter, so the table's kind is never lowered.
 */
export function classify(prepared: PreparedRead, options: Options, input: ClassifyInput): Classification {
  if (prepared.kind === "read") {
    if (prepared.effects.length > 0 || prepared.unresolved.length > 0) {
      // §5.1 steps 4 and 5 send these to the change path; only a Read and write account may run them.
      return { category: "write", capEnforceable: prepared.cap.enforceable, jobTimeoutSeconds: normalTimeout(input, options) }
    }
    if (prepared.cap.enforceable) {
      throw new BigQueryError(
        "CATEGORY_MISMATCH",
        "The SQL is a SELECT the byte cap can bound, so it runs through bigquery_query and needs no plan",
        "Call bigquery_query({ sql }) instead.",
      )
    }
    if (options.uncappedReads === "refuse") {
      throw new BigQueryError(
        "CAP_NOT_ENFORCEABLE",
        `The byte cap cannot bound this query: ${prepared.cap.whyNot ?? "an unknown condition"}, and the account's uncappedReads option refuses one`,
        "Ask the user to set uncappedReads to ask, or narrow the query to native tables without row access policies.",
      )
    }
    return { category: "uncapped-read", capEnforceable: false, jobTimeoutSeconds: uncappedTimeout(input, options) }
  }

  if (prepared.statementType === "SCRIPT") {
    if (!options.scripts) {
      throw new BigQueryError("SCRIPT_REFUSED", "The plugin's scripts option is off, so a script cannot be planned", "Split the script into single statements, or ask the user to set scripts to true.")
    }
    if (input.requestedBytes === undefined) {
      throw new BigQueryError(
        "SCRIPT_CAP_REQUIRED",
        "A script needs an explicit maxBytes, because its estimate covers only its leading statements",
        "Plan it again with maxBytes.",
      )
    }
    return { category: prepared.kind, capEnforceable: false, jobTimeoutSeconds: Math.min(input.jobTimeoutSeconds ?? SCRIPT_TIMEOUT_SECONDS, SCRIPT_TIMEOUT_SECONDS) }
  }

  if (prepared.kind === "admin") {
    if (!options.admin.enabled) {
      throw new BigQueryError("PERMISSION_DENIED", "Admin statements are off by the plugin's admin option", "Ask the user to set admin.enabled to true.")
    }
    if (options.admin.requireReason && input.reason === undefined) {
      throw new BigQueryError("ADMIN_REASON_REQUIRED", "An admin plan needs a reason, which the preview shows", "Plan it again with reason.")
    }
  }

  return { category: prepared.kind, capEnforceable: prepared.cap.enforceable, jobTimeoutSeconds: normalTimeout(input, options) }
}

function normalTimeout(input: ClassifyInput, options: Options): number {
  return Math.max(1, Math.min(input.jobTimeoutSeconds ?? options.jobTimeoutSeconds, 21_600))
}

function uncappedTimeout(input: ClassifyInput, options: Options): number {
  return Math.max(1, Math.min(input.jobTimeoutSeconds ?? options.uncappedTimeoutSeconds, options.uncappedTimeoutSeconds))
}

/**
 * Whether the text defines a temporary table, which a dry run does not support (Google's multi-statement page:
 * “Dry runs of `CREATE TEMP TABLE` statements aren't supported”). This reads statement wording only, never a table name;
 * it is used only to name the refusal a failed dry run deserves, never to decide what a statement touches.
 */
export function definesTempTable(sql: string): boolean {
  const lexed = createLexer().lex(sql)
  if (!lexed.ok) return false
  const tokens = significantTokens(lexed.tokens)
  for (let index = 0; index < tokens.length; index += 1) {
    const word = valueOf(tokens[index])
    if (word !== "TEMP" && word !== "TEMPORARY") continue
    if (valueOf(tokens[index + 1]) !== "TABLE") continue
    for (let back = index - 1; back >= 0 && back >= index - 8; back -= 1) if (valueOf(tokens[back]) === "CREATE") return true
  }
  return false
}

const valueOf = (token: Token | undefined) => (token !== undefined && (token.kind === "keyword" || token.kind === "identifier") ? token.value.toUpperCase() : undefined)

/** A DDL/DCL target outside the account's dataset fence is refused, like any referenced object (design §5.4). */
export function assertTargetsFenced(fence: Fence | undefined, targets: readonly Target[]): void {
  for (const target of targets) {
    const object = { project: target.project, dataset: target.dataset, name: target.name, kind: target.kind }
    if (!isFenced(fence, object)) continue
    throw new BigQueryError(
      "DATASET_FENCED",
      `The ${target.kind} ${target.label} is outside the account's dataset fence`,
      "Use a dataset the fence allows, or ask the user to change the account's datasets option.",
    )
  }
}

/**
 * The referenced objects as the plan's output shows them: what the dry run and expansion saw, each with its facts. A
 * native table's row-access verdict comes from package C's own prober, whose 10-minute cache the read guards filled, so
 * the preview states it without a second check (design §5.2).
 */
export async function referencedRecords(prepared: PreparedRead, context: HandlerContext): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  const prober = new RowPolicyProber(
    { ports: context.ports, account: context.account, project: prepared.project, signal: context.call.signal },
    cacheOf<RowVerdict>(context.ports.clock, "rowpolicy", 10 * 60_000, () => context.ports.clock.now()),
  )
  for (const facts of prepared.tables) out.push(tableRecord("table", facts, await rowVerdict(prober, facts)))
  for (const facts of prepared.views) out.push(tableRecord("view", facts))
  for (const routine of prepared.routines) {
    const ref = routine.routineReference
    out.push({
      kind: "routine",
      name: `${ref.projectId}.${ref.datasetId}.${ref.routineId}`,
      type: routine.routineType ?? "",
      language: routine.language ?? "",
      remote: routine.remoteFunctionOptions !== undefined,
    })
  }
  for (const graph of prepared.statistics.referencedPropertyGraphs ?? []) {
    out.push({ kind: "property graph", name: `${graph.projectId}.${graph.datasetId}.${graph.propertyGraphId}` })
  }
  return out
}

function tableRecord(kind: "table" | "view", facts: PreparedRead["tables"][number], rowSecured?: boolean | "unknown"): Record<string, unknown> {
  return {
    kind,
    name: facts.name,
    type: facts.info.type ?? "",
    ...(facts.location !== undefined ? { location: facts.location } : {}),
    storage: facts.storage,
    tagged: [...facts.tagged],
    ...(rowSecured !== undefined ? { rowSecured } : {}),
    bytes: facts.numBytes,
    ...(facts.whyNotNative !== undefined ? { whyNotNative: facts.whyNotNative } : {}),
  }
}

/** A native data table's row-access verdict; a view, an external table or an unknown type has no policy of its own. */
async function rowVerdict(prober: RowPolicyProber, facts: PreparedRead["tables"][number]): Promise<boolean | "unknown" | undefined> {
  if (facts.kind !== "data" || facts.storage !== "native") return undefined
  const verdict = await prober.probe(facts)
  return verdict.state === "secured" ? true : verdict.state === "unknown" ? "unknown" : false
}

/** The plan's referenced names, in the store's `PlanPreview.referenced` shape. */
function referencedNames(prepared: PreparedRead): string[] {
  return [
    ...prepared.tables.map((facts) => facts.name),
    ...prepared.views.map((facts) => facts.name),
    ...prepared.routines.map((routine) => `${routine.routineReference.projectId}.${routine.routineReference.datasetId}.${routine.routineReference.routineId}`),
    ...(prepared.statistics.referencedPropertyGraphs ?? []).map((graph) => `${graph.projectId}.${graph.datasetId}.${graph.propertyGraphId}`),
  ]
}

/** `bigquery_plan`'s handler. */
export const plan: NonNullable<Handlers["plan"]> = async (input, context) => {
  const requested = input.maxBytes !== undefined ? bytesOf(input.maxBytes) : undefined
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, call: context.call, via: "bigquery_plan" })

  let prepared: PreparedRead
  try {
    prepared = await prepareRead(
      rc,
      {
        sql: input.sql,
        ...(input.params !== undefined ? { params: input.params } : {}),
        ...(input.project !== undefined ? { project: input.project } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(requested !== undefined ? { maxBytes: requested } : {}),
      },
      "inspect",
    )
  } catch (error) {
    // A dry run cannot analyse CREATE TEMP TABLE (Google's multi-statement page, cited in definesTempTable). BigQuery
    // answers SQL_INVALID; the wording check names the refusal the design asks for.
    if (error instanceof BigQueryError && error.code === "SQL_INVALID" && definesTempTable(input.sql)) {
      throw new BigQueryError(
        "SCRIPT_NOT_DRY_RUNNABLE",
        "The script creates a temporary table, and BigQuery's dry runs do not support CREATE TEMP TABLE",
        "Replace the temporary table with a CTE or a dataset table, then plan again.",
      )
    }
    throw error
  }

  const statistics = changeStatistics(prepared.statistics)
  const targets = targetsOf(statistics, prepared.statementType, statistics.referencedTables ?? [])
  assertTargetsFenced(rc.settings.fence, targets)

  const classification = classify(prepared, context.options, {
    ...(requested !== undefined ? { requestedBytes: requested } : {}),
    ...(input.jobTimeoutSeconds !== undefined ? { jobTimeoutSeconds: input.jobTimeoutSeconds } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  })
  const bound = boundSentence({
    category: classification.category,
    statementType: prepared.statementType,
    capEnforceable: classification.capEnforceable,
    ...(prepared.cap.whyNot !== undefined ? { capWhyNot: prepared.cap.whyNot } : {}),
    jobTimeoutSeconds: classification.jobTimeoutSeconds,
    effects: prepared.effects,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(targets.some((target) => target.source === "referenced") ? { referencedTargets: true } : {}),
  })

  const cap = await capAndBudget({
    options: context.options,
    ports: context.ports,
    account: context.account,
    session: sessionHash(context.call.sessionID),
    now: context.ports.clock.now(),
    estimateBytes: prepared.bytes,
    ...(requested !== undefined ? { requested } : {}),
  })
  if (prepared.bytes > cap.capBytes) {
    throw new BigQueryError(
      "COST_CAP",
      `The estimate is ${prepared.bytes} bytes and the cap is ${cap.capBytes} bytes${cap.remainingBytes !== undefined ? ` (the budget leaves ${cap.remainingBytes})` : ""}`,
      `Narrow the statement, or pass maxBytes up to the account's maxBytesCeiling of ${context.options.maxBytesCeiling} bytes.`,
    )
  }

  // A plan that would commit needs the write level; an uncapped-read plan runs from either level. The decision is
  // Google's, through package A; on a Read record it makes no Google call.
  const level = await context.ports.auth.level(context.account, context.call.signal)
  const committable = classification.category === "uncapped-read" || level.level === "write"

  const preview: PlanPreview = {
    category: classification.category,
    statementType: prepared.statementType,
    targets: targets.map((target) => target.label),
    referenced: referencedNames(prepared),
    bytes: prepared.bytes,
    accuracy: prepared.accuracy ?? "not reported",
    usd: usdFor(prepared.bytes, context.options),
    capBytes: cap.capBytes,
    bound,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  }
  const statement: PlannedStatement = {
    sql: input.sql,
    ...(input.params !== undefined ? { params: input.params } : {}),
    project: prepared.project,
    location: prepared.location,
    statementType: prepared.statementType,
    targets: [...preview.targets],
    estimateBytes: prepared.bytes,
    capBytes: cap.capBytes,
    capEnforceable: classification.capEnforceable,
    jobTimeoutSeconds: classification.jobTimeoutSeconds,
  }
  const created: Plan = context.ports.plans.create({
    category: classification.category,
    account: context.account,
    sessionId: context.call.sessionID,
    agentId: context.call.agent,
    statement,
    preview,
    committable,
    ttlSeconds: context.options.planTtlSeconds,
  })

  const output: OutputOf<"plan"> = {
    state: "done",
    planId: created.id,
    category: created.category,
    committable,
    commitWith: commitCall(created.category),
    preview: {
      statementType: preview.statementType,
      targets: [...preview.targets],
      referenced: await referencedRecords(prepared, context),
      bytes: preview.bytes,
      accuracy: preview.accuracy,
      usd: preview.usd,
      capBytes: preview.capBytes,
      bound: preview.bound,
      ...(preview.reason !== undefined ? { reason: preview.reason } : {}),
    },
    expiresAt: new Date(created.expiresAt).toISOString(),
    ...(cap.warnings.length > 0 ? { warnings: cap.warnings.map((warning) => ({ ...warning })) } : {}),
  }
  return output
}
