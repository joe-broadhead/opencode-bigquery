/**
 * Package C's tools: `bigquery_list`, `_table`, `_search`, `_estimate`, `_query`, `_job`, `_jobs` and `_profile`
 * (design §4). Everything billed goes through the read path (`prepareRead` + `runRead`), so a search's
 * `INFORMATION_SCHEMA` read, a table's partitions and a profile are guarded exactly like a query: dry run first, the
 * statement type, expansion, the fence, the cap and the policy-tag rule.
 *
 * The registry has already resolved the account and asserted the tool's own action; the ports are guarded so no request
 * can happen before that. Nothing here builds a `message` or a `next` from Google's text or from a row (§5.6): a name in
 * one comes from `src/domain/identifiers.ts`.
 */
import { ASKS } from "../domain/actions.js"
import { operationResource } from "../domain/accounts.js"
import { BigQueryError } from "../domain/errors.js"
import type { RoutineInfo, SchemaField, TableInfo, TableReference } from "../domain/google.js"
import { column, path } from "../domain/identifiers.js"
import type { OutputOf } from "../domain/contract.js"
import { parseBytes } from "../options.js"
import type { HandlerContext, Handlers } from "../registry.js"
import type { JobStatus, ResultPage } from "../ports.js"
import { cacheOf } from "../guards/cache.js"
import { assertFenced, isFenced } from "../guards/fence.js"
import { failureFor, googleErrorText } from "../guards/jobfail.js"
import { createLexer } from "../guards/lexer.js"
import { actionOf } from "../domain/actions.js"
import { assertObjectResources, jobVerdict, prepareRead, readContext, runRead, saveNext, type PreparedRead, type ReadContext, type ReadRun } from "../guards/read.js"
import { cellValue, rowValues, shapeRows } from "../guards/results.js"
import { RowPolicyProber, type RowVerdict } from "../guards/rowpolicy.js"
import { inlineDenied, rowGate } from "../guards/rows.js"
import type { PolicyVerdict } from "../guards/policy.js"
import type { FenceObject } from "../guards/fence.js"
import { sessionHash } from "../guards/session.js"
import { locationOf, projectOf, settingsOf } from "../guards/settings.js"
import { quoteIdent, quoteLiteral, tableSql } from "../guards/sql.js"
import { flattenSchema, GROUPABLE, isOrderable, isStruct, NUMERIC_TYPES, tableFacts, type TableFacts } from "../guards/tables.js"

const invalid = (detail: string, next?: string) => new BigQueryError("INPUT_INVALID", detail, next)

/** The page size for a list call: the caller's limit, within Google's maximum. */
const pageSize = (limit: number) => Math.max(1, Math.min(limit, 1_000))

/** Whether a list item matches the call's filter, case-insensitively. */
const matches = (values: readonly (string | undefined)[], filter: string | undefined) =>
  filter === undefined || values.some((value) => value !== undefined && value.toLowerCase().includes(filter.toLowerCase()))

const cut = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A byte size from the input: a number, or a string such as `512MiB`. */
const bytesOf = (value: string | number) => (typeof value === "number" ? value : parseBytes(value))

// ── bigquery_list ────────────────────────────────────────────────────────

const list: Handlers["list"] = async (input, context) => {
  const settings = settingsOf(context.options, context.account)
  const limit = input.limit ?? 100
  const signal = context.call.signal
  const page = { account: context.account, ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}), maxResults: pageSize(limit) }

  if (input.dataset !== undefined && input.project === undefined) throw invalid("A dataset belongs to a project: pass project with dataset")
  if (input.kind === "routines" && input.dataset === undefined) throw invalid("kind: routines lists a dataset's routines: pass dataset")

  if (input.project === undefined) {
    const answer = await context.ports.bigquery.listProjects(page, signal)
    const items = answer.items
      .filter((project) => matches([project.projectId, project.friendlyName], input.filter))
      .map((project) => ({ project: project.projectId, ...(project.friendlyName !== undefined ? { name: cut(project.friendlyName) } : {}) }))
    return { state: "done", items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" }
  }

  const project = projectOf(settings, input.project)
  if (input.dataset === undefined) {
    const answer = await context.ports.bigquery.listDatasets({ ...page, project }, signal)
    const items = answer.items
      .filter((dataset) => matches([dataset.ref.datasetId], input.filter))
      .map((dataset) => ({ project, dataset: dataset.ref.datasetId, ...(dataset.location !== undefined ? { location: dataset.location } : {}) }))
    return { state: "done", items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" }
  }

  const dataset = { projectId: project, datasetId: input.dataset }
  if (input.kind === "routines") {
    const answer = await context.ports.bigquery.listRoutines({ ...page, dataset }, signal)
    const items = answer.items.filter((routine) => matches([routine.routineReference.routineId], input.filter)).map(routineItem)
    return { state: "done", items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" }
  }

  const answer = await context.ports.bigquery.listTables({ ...page, dataset }, signal)
  const kept = answer.items.filter((table) => matches([table.tableReference.tableId, table.description], input.filter))
  const items: Record<string, unknown>[] = kept.map(tableItem)
  if (input.details === true) {
    for (const [index, table] of kept.slice(0, 25).entries()) {
      const info = await context.ports.bigquery.getTable(context.account, table.tableReference, signal)
      items[index] = { ...items[index], ...detailsOf(info) }
    }
  }
  return { state: "done", items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" }
}

function tableItem(table: TableInfo): Record<string, unknown> {
  const ref = table.tableReference
  return {
    project: ref.projectId,
    dataset: ref.datasetId,
    table: ref.tableId,
    ...(table.type !== undefined ? { type: table.type } : {}),
    ...(table.location !== undefined ? { location: table.location } : {}),
    ...(table.timePartitioning !== undefined || table.rangePartitioning !== undefined ? { partitioned: true } : {}),
    ...(table.clustering?.fields !== undefined ? { clustered: true } : {}),
    ...(table.description !== undefined ? { description: cut(table.description) } : {}),
  }
}

function routineItem(routine: RoutineInfo): Record<string, unknown> {
  const ref = routine.routineReference
  return {
    project: ref.projectId,
    dataset: ref.datasetId,
    routine: ref.routineId,
    ...(routine.routineType !== undefined ? { type: routine.routineType } : {}),
    ...(routine.language !== undefined ? { language: routine.language } : {}),
    remote: routine.remoteFunctionOptions !== undefined,
    ...(routine.arguments !== undefined ? { arguments: routine.arguments.length } : {}),
  }
}

function detailsOf(info: TableInfo): Record<string, unknown> {
  return {
    ...(info.numRows !== undefined ? { rows: Number(info.numRows) } : {}),
    ...(info.numBytes !== undefined ? { bytes: Number(info.numBytes) } : {}),
    ...(info.lastModifiedTime !== undefined ? { modified: isoTime(info.lastModifiedTime) } : {}),
  }
}

// ── bigquery_table ───────────────────────────────────────────────────────

const table: Handlers["table"] = async (input, context) => {
  const settings = settingsOf(context.options, context.account)
  const project = projectOf(settings, input.project)
  const signal = context.call.signal
  const ref = { projectId: project, datasetId: input.dataset, tableId: input.table }
  const info = await context.ports.bigquery.getTable(context.account, ref, signal)
  const facts = tableFacts(info)
  const viewSql = info.view?.query ?? info.materializedView?.query

  const out: OutputOf<"table"> = {
    state: "done",
    table: { project, dataset: input.dataset, table: input.table },
    ...(info.type !== undefined ? { type: info.type } : {}),
    columns: flattenSchema(facts.columns),
    ...(partitioningOf(info) ? { partitioning: partitioningOf(info) } : {}),
    ...(info.clustering?.fields !== undefined ? { clustering: [...info.clustering.fields] } : {}),
    ...(info.numRows !== undefined ? { rows: Number(info.numRows) } : {}),
    ...(info.numBytes !== undefined ? { bytes: Number(info.numBytes) } : {}),
    ...(info.lastModifiedTime !== undefined ? { modified: isoTime(info.lastModifiedTime) } : {}),
    ...(viewSql !== undefined ? { viewSql: viewSql.slice(0, 2_000) } : {}),
    trust: "untrusted",
  }

  if (input.sample !== undefined && input.sample > 0) {
    // A sample reads rows, so it is a data read: the fence applies before tabledata.list, exactly as for a query.
    assertFenced(settings.fence, [{ project, dataset: input.dataset, name: input.table, kind: "table" }])
    Object.assign(out, await sampleRows(facts, input.sample, context))
  }
  if (input.partitions === true) Object.assign(out, await partitionsOf(project, input.dataset, input.table, context))
  return out
}

async function sampleRows(facts: TableFacts, rows: number, context: HandlerContext): Promise<Record<string, unknown>> {
  const unavailable = (why: string) => ({ sample: { unavailable: why } })
  if (facts.kind === "view") return unavailable("A view has no stored rows to sample")
  if (facts.kind !== "data") return unavailable("Only a native table has rows this tool samples")
  if (facts.columns.length === 0) return unavailable("The table's schema names no column to read")
  const readable = facts.columns.filter((field) => !facts.tagged.includes(field.name))
  if (readable.length === 0) return unavailable("Every column of the table is policy-tagged")
  // §5.4's per-table assert, and the shared row gate: Q11's inline option covers every row that would reach the
  // model, a sample included (review M-2, H-1).
  await assertObjectResources({
    call: context.call,
    account: context.account,
    action: actionOf("table").action,
    via: "bigquery_table",
    objects: [{ project: facts.project, dataset: facts.dataset, name: facts.table, kind: "table" }],
  })
  const gate = rowGate({ options: context.options, account: context.account, settings: settingsOf(context.options, context.account), tables: [facts], policy: { inline: true } })
  if (!gate.inline) return { ...unavailable("The account's inline option makes this dataset save-only"), warnings: [...gate.warnings] }

  const prober = new RowPolicyProber(
    { ports: context.ports, account: context.account, project: facts.project, signal: context.call.signal },
    cacheOf<RowVerdict>(context.ports.clock, "rowpolicy", 10 * 60_000, () => context.ports.clock.now()),
  )
  const verdict = await prober.probe(facts)
  if (verdict.state === "secured") return unavailable("The table has a row access policy, so a sample could show rows the caller may not read")
  if (verdict.state === "unknown") return unavailable("The row-access check on the table could not be completed")

  let page: ResultPage
  try {
    page = await context.ports.bigquery.listTableData(
      context.account,
      facts.info.tableReference,
      { maxResults: rows, selectedFields: readable.map((field) => field.name) },
      context.call.signal,
    )
  } catch (error) {
    if (error instanceof BigQueryError && (error.code === "PERMISSION_DENIED" || error.code === "COLUMN_DENIED")) return unavailable("The table refused the sample")
    throw error
  }
  return {
    sample: shapeSample(page, readable, rows, context.options.maxInlineBytes),
    ...(facts.tagged.length > 0 ? { withheld: [...facts.tagged] } : {}),
  }
}

/** The sample as the tool's own shape: arrays in the readable columns' order, with the query tool's cell rules. */
function shapeSample(page: ResultPage, fields: readonly SchemaField[], maxRows: number, maxInlineBytes: number): unknown[][] {
  const rows: unknown[][] = []
  let used = 0
  for (const raw of page.rows.slice(0, maxRows)) {
    const shaped = rowValues(raw).map((value, index) => cellValue(value, fields[index]).value)
    const size = Buffer.byteLength(JSON.stringify(shaped) ?? "")
    if (rows.length > 0 && used + size > maxInlineBytes) break
    used += size
    rows.push(shaped)
  }
  return rows
}

async function partitionsOf(project: string, dataset: string, table: string, context: HandlerContext): Promise<Record<string, unknown>> {
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, call: context.call, via: "bigquery_table" })
  const sql = `SELECT table_name, partition_id, total_rows, total_billable_bytes, last_modified_time FROM ${quoteIdent(project)}.${quoteIdent(dataset)}.INFORMATION_SCHEMA.PARTITIONS WHERE table_name = @table ORDER BY partition_id LIMIT 1000`
  const prepared = await prepareRead(rc, { sql, params: { table }, project }, "read")
  const run = await runRead(rc, prepared, { maxRows: 1_000, waitSeconds: 240 })
  if (run.state === "running") throw new BigQueryError("JOB_TIMEOUT", "The partitions query is still running", "Run the same query with bigquery_query, or wait and try the table again.")
  if (run.state === "failed") throw new BigQueryError(run.failure!.code, run.failure!.detail, run.failure!.next)
  return {
    partitions: (run.rows ?? []).map((row) => ({
      partition: String(row[1] ?? ""),
      rows: Number(row[2] ?? 0),
      bytes: Number(row[3] ?? 0),
      ...(row[4] !== undefined && row[4] !== null ? { modified: String(row[4]) } : {}),
    })),
    ...(run.warnings.length > 0 ? { warnings: [...run.warnings] } : {}),
  }
}

function partitioningOf(info: TableInfo): Record<string, unknown> | undefined {
  const time = info.timePartitioning
  if (time !== undefined) {
    return {
      type: time.type ?? "DAY",
      ...(time.field !== undefined ? { field: time.field } : {}),
      requirePartitionFilter: info.requirePartitionFilter === true || time.requirePartitionFilter === true,
    }
  }
  const range = info.rangePartitioning
  if (range !== undefined) {
    return {
      type: "RANGE",
      ...(range.field !== undefined ? { field: range.field } : {}),
      ...(range.range !== undefined ? { range: { ...range.range } } : {}),
      requirePartitionFilter: info.requirePartitionFilter === true,
    }
  }
  if (info.requirePartitionFilter === true) return { type: "INGESTION", requirePartitionFilter: true }
  return undefined
}

// ── bigquery_search ──────────────────────────────────────────────────────

/** At most this many datasets are searched through their own views before falling back to names. */
const SEARCH_DATASETS = 10

type Found = { table: { project: string; dataset: string; table: string }; column?: string; where: "name" | "description" }

const search: Handlers["search"] = async (input, context) => {
  const settings = settingsOf(context.options, context.account)
  const project = projectOf(settings, input.project)
  const limit = input.limit ?? 50
  const location = locationOf(settings, input.location)
  const needle = input.query.toLowerCase()
  const pattern = `%${escapeLike(needle)}%`
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, call: context.call, via: "bigquery_search" })

  // 1. The region-qualified view: one read covering this project's region.
  if (location !== undefined) {
    try {
      const sql = `SELECT table_catalog, table_schema, table_name, column_name, field_path, description FROM \`region-${location.toLowerCase()}\`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS WHERE LOWER(table_name) LIKE @q OR LOWER(column_name) LIKE @q OR LOWER(IFNULL(description, '')) LIKE @q LIMIT ${Math.max(1, Math.min(limit, 200))}`
      const out = await searchRead(rc, project, sql, pattern, limit, needle)
      if (out.matches.length > 0) return { state: "done", matches: out.matches, via: "region", ...cost(out.processed, out.billed), trust: "untrusted" }
    } catch (error) {
      if (!fallbackable(error)) throw error
    }
  }

  // 2. Each dataset's own view: at least 10 MiB each, so the fence's datasets come first and at most ten run.
  const datasets = await searchDatasets(context, project, settings.fence)
  const found: Found[] = []
  let processed = 0
  let billed = 0
  for (const dataset of datasets) {
    if (found.length >= limit) break
    try {
      const sql = `SELECT table_catalog, table_schema, table_name, column_name, field_path, description FROM ${quoteIdent(dataset.project)}.${quoteIdent(dataset.dataset)}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS WHERE LOWER(table_name) LIKE @q OR LOWER(column_name) LIKE @q OR LOWER(IFNULL(description, '')) LIKE @q LIMIT ${Math.max(1, Math.min(limit - found.length, 200))}`
      const out = await searchRead(rc, project, sql, pattern, limit - found.length, needle)
      processed += out.processed
      billed += out.billed
      found.push(...out.matches)
    } catch (error) {
      if (!fallbackable(error)) throw error
    }
  }
  if (found.length > 0) return { state: "done", matches: found, via: "dataset", ...cost(processed, billed), trust: "untrusted" }

  // 3. Plain table names: free, and the honest answer when the views are not readable.
  const names = await searchNames(context, project, datasets, needle, limit, settings.fence)
  return { state: "done", matches: names, via: "names", trust: "untrusted" }
}

async function searchRead(rc: ReadContext, project: string, sql: string, pattern: string, limit: number, needle: string): Promise<{ matches: Found[]; processed: number; billed: number }> {
  const prepared = await prepareRead(rc, { sql, params: { q: pattern }, project }, "read")
  const run = await runRead(rc, prepared, { maxRows: Math.max(1, Math.min(limit, 200)), waitSeconds: 30 })
  if (run.state === "running") throw new BigQueryError("JOB_TIMEOUT", "The search query is still running", "Try the search again in a moment.")
  if (run.state === "failed") throw new BigQueryError(run.failure!.code, run.failure!.detail, run.failure!.next)
  return {
    matches: foundRows(run, needle).filter((found) => !isFenced(rc.settings.fence, { project: found.table.project, dataset: found.table.dataset, name: found.table.table, kind: "table" })),
    processed: run.bytesProcessed,
    billed: run.bytesBilled,
  }
}

function foundRows(run: ReadRun, needle: string): Found[] {
  const out: Found[] = []
  for (const row of run.rows ?? []) {
    const text = (value: unknown) => (value === undefined || value === null ? "" : String(value))
    const project = text(row[0])
    const dataset = text(row[1])
    const table = text(row[2])
    if (table === "" || dataset === "") continue
    const name = text(row[3])
    const field = text(row[4]) || name
    const description = text(row[5])
    const byColumn = field.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)
    out.push({
      table: { project, dataset, table },
      ...(field !== "" && field.toLowerCase() !== table.toLowerCase() ? { column: field } : {}),
      where: byColumn || table.toLowerCase().includes(needle) ? "name" : "description",
    })
    void description
  }
  return out
}

async function searchDatasets(context: HandlerContext, project: string, fence: ReturnType<typeof settingsOf>["fence"]): Promise<{ project: string; dataset: string }[]> {
  const named = (fence?.allow ?? [])
    .filter((pattern) => !pattern.includes("*"))
    .map((pattern) => {
      const [owner, dataset] = pattern.split(".")
      return { project: owner ?? project, dataset: dataset ?? "" }
    })
    .filter((entry) => entry.dataset !== "")
  if (named.length > 0) return named.slice(0, SEARCH_DATASETS)
  const page = await context.ports.bigquery.listDatasets({ account: context.account, project, maxResults: SEARCH_DATASETS }, context.call.signal)
  return page.items.slice(0, SEARCH_DATASETS).map((dataset) => ({ project, dataset: dataset.ref.datasetId }))
}

async function searchNames(context: HandlerContext, project: string, datasets: readonly { project: string; dataset: string }[], needle: string, limit: number, fence: ReturnType<typeof settingsOf>["fence"]): Promise<Found[]> {
  const out: Found[] = []
  for (const dataset of datasets) {
    if (out.length >= limit) break
    try {
      const page = await context.ports.bigquery.listTables(
        { account: context.account, dataset: { projectId: dataset.project || project, datasetId: dataset.dataset }, maxResults: 200 },
        context.call.signal,
      )
      for (const table of page.items) {
        if (out.length >= limit) break
        const inName = table.tableReference.tableId.toLowerCase().includes(needle)
        const inDescription = table.description !== undefined && table.description.toLowerCase().includes(needle)
        if (!inName && !inDescription) continue
        // Names are metadata, but a fenced account hears about none of the objects outside its fence.
        if (isFenced(fence, { project: dataset.project || project, dataset: dataset.dataset, name: table.tableReference.tableId, kind: "table" })) continue
        out.push({ table: { project: dataset.project || project, dataset: dataset.dataset, table: table.tableReference.tableId }, where: inName ? "name" : "description" })
      }
    } catch (error) {
      if (error instanceof BigQueryError && (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED")) continue
      throw error
    }
  }
  return out
}

const cost = (processed: number, billed: number) => ({ bytesProcessed: processed, bytesBilled: billed })

/** A LIKE pattern from the caller's words: the wildcards are the plugin's, not the input's. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`)

/** An error a search falls back from: a view the caller may not read, a fence, a plan, or a missing view. */
function fallbackable(error: unknown): boolean {
  if (!(error instanceof BigQueryError)) return false
  return ["PERMISSION_DENIED", "COLUMN_DENIED", "DATASET_FENCED", "NEEDS_PLAN", "CAP_NOT_ENFORCEABLE", "NOT_FOUND", "SQL_INVALID"].includes(error.code)
}

// ── bigquery_estimate ────────────────────────────────────────────────────

const estimate: Handlers["estimate"] = async (input, context) => {
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, call: context.call, via: "bigquery_estimate" })
  const prepared = await prepareRead(
    rc,
    {
      sql: input.sql,
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
    },
    "inspect",
  )
  const statistics = prepared.statistics
  return {
    state: "done",
    statementType: prepared.statementType,
    category: prepared.kind,
    referenced: {
      tables: prepared.tables.map((facts) => facts.name),
      views: prepared.views.map((facts) => facts.name),
      routines: prepared.routines.map((routine) => `${routine.routineReference.projectId}.${routine.routineReference.datasetId}.${routine.routineReference.routineId}`),
      propertyGraphs: (statistics.referencedPropertyGraphs ?? []).map((graph) => `${graph.projectId}.${graph.datasetId}.${graph.propertyGraphId}`),
    },
    bytes: prepared.bytes,
    ...(prepared.accuracy !== undefined ? { accuracy: prepared.accuracy } : {}),
    costUsd: prepared.usd,
    capEnforceable: prepared.cap.enforceable,
    ...(prepared.cap.whyNot !== undefined ? { whyNot: prepared.cap.whyNot } : {}),
    ...(statistics.schema?.fields !== undefined ? { schema: statistics.schema.fields.map((field) => ({ name: cut(field.name), type: field.type })) } : {}),
    hints: [...prepared.hints],
    location: prepared.location,
  }
}

// ── bigquery_query ───────────────────────────────────────────────────────

const query: Handlers["query"] = async (input, context) => {
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, call: context.call, via: "bigquery_query" })
  if (input.planId !== undefined) return runUncappedPlan(input.planId, rc, context)
  const prepared = await prepareRead(
    rc,
    {
      sql: input.sql!,
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: bytesOf(input.maxBytes) } : {}),
      ...(input.useCache !== undefined ? { useCache: input.useCache } : {}),
    },
    "read",
  )
  const run = await runRead(rc, prepared, { maxRows: input.maxRows ?? context.options.maxRows, waitSeconds: input.wait ?? 30 })
  return queryResult(prepared, run, context)
}

/**
 * `bigquery_query({ planId })`: an uncapped-read plan. The plan is acquired (single use, bound to this session, agent
 * and account), then `bigquery.uncapped_read` is asserted before any Google call, then the statement is re-checked
 * against the plan and runs with the plan's cap and the short limit a cap-unenforceable read gets.
 */
async function runUncappedPlan(planId: string, rc: ReadContext, context: HandlerContext) {
  const plan = context.ports.plans.acquire(planId, { sessionId: context.call.sessionID, agentId: context.call.agent, account: context.account, category: "uncapped-read" })
  try {
    if (context.options.uncappedReads === "refuse") {
      throw new BigQueryError("CAP_NOT_ENFORCEABLE", "This account refuses reads the byte cap cannot bound", "Narrow the query to native tables without row access policies, or ask the user to set uncappedReads to ask.")
    }
    await context.call.assert({
      action: ASKS.uncappedRead,
      resources: [operationResource(context.account, "bigquery.jobs.query")],
      metadata: { planId: plan.id, account: context.account, statementType: plan.statement.statementType, category: plan.category, bytes: plan.statement.estimateBytes, bound: plan.preview.bound },
    })
    const prepared = await prepareRead(
      rc,
      {
        sql: plan.statement.sql,
        ...(plan.statement.params !== undefined ? { params: plan.statement.params } : {}),
        project: plan.statement.project,
        location: plan.statement.location,
        maxBytes: plan.statement.capBytes,
      },
      "inspect",
    )
    if (prepared.statementType !== plan.statement.statementType) {
      throw new BigQueryError("PLAN_CHANGED", "The statement's type changed since the plan was made", "Plan again and show the user the new preview.")
    }
    if (prepared.kind !== "read" || prepared.effects.length > 0) {
      throw new BigQueryError("PLAN_CHANGED", "The statement is no longer a side-effect-free read", "Plan again and show the user the new preview.")
    }
    if (prepared.location !== plan.statement.location) {
      throw new BigQueryError("PLAN_CHANGED", "The statement's location changed since the plan was made", "Plan again and show the user the new preview.")
    }
    if (prepared.bytes > plan.statement.estimateBytes * 1.1) {
      throw new BigQueryError("PLAN_CHANGED", "The statement's estimate grew more than 10 percent since the plan was made", "Plan again and show the user the new preview.")
    }
    const run = await runRead(rc, prepared, {
      maxRows: context.options.maxRows,
      waitSeconds: 30,
      maxBytes: plan.statement.capBytes,
      timeoutSeconds: Math.min(plan.statement.jobTimeoutSeconds, context.options.uncappedTimeoutSeconds),
    })
    context.ports.plans.complete(planId)
    return queryResult(prepared, run, context)
  } catch (error) {
    context.ports.plans.release(planId)
    throw error
  }
}

function queryResult(prepared: PreparedRead, run: ReadRun, context: HandlerContext) {
  const costFields = { bytesProcessed: run.bytesProcessed, bytesBilled: run.bytesBilled, costUsd: run.usd, cacheHit: run.cacheHit }
  if (run.state === "failed") {
    return {
      state: "failed" as const,
      error: run.failure!.code,
      message: run.failure!.detail,
      ...(run.failure!.next !== undefined ? { next: run.failure!.next } : {}),
      job: run.job,
      ...costFields,
    }
  }
  if (run.state === "running") return { state: "running" as const, job: run.job, ...costFields, next: jobNext(run.job) }
  const saved = run.inline === false
  const more = run.truncated?.rows === true || run.truncated?.bytes === true
  return {
    state: "done" as const,
    columns: [...(run.columns ?? [])],
    rows: (run.rows ?? []).map((row) => [...row]),
    totalRows: run.totalRows,
    returned: run.returned,
    ...(run.truncated ? { truncated: { ...run.truncated } } : {}),
    ...costFields,
    job: run.job,
    ...(run.warnings.length > 0 ? { warnings: [...run.warnings] } : {}),
    ...(saved || more ? { next: saveNext(run.job) } : {}),
    trust: "untrusted" as const,
  }
}

const jobNext = (job: { readonly project: string; readonly jobId: string; readonly location: string }) =>
  `bigquery_job({ project: ${plain(job.project)}, jobId: ${plain(job.jobId)}, location: ${plain(job.location)}, wait: 30 })`

/** A validated identifier for a `next`, in backquotes; anything else is `object`. */
const plain = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`")

// ── bigquery_job ─────────────────────────────────────────────────────────

/** The statement types whose jobs have result rows to page through. */
const RESULT_TYPES = new Set(["SELECT", "ASSERT", "SCRIPT", "CALL"])

const job: Handlers["job"] = async (input, context) => {
  const settings = settingsOf(context.options, context.account)
  const project = projectOf(settings, input.project)
  const location = locationOf(settings, input.location)
  const signal = context.call.signal
  const ref = { projectId: project, jobId: input.jobId, ...(location !== undefined ? { location } : {}) }
  const status = await context.ports.bigquery.getJob(context.account, ref, signal)
  const shown = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? location ?? "" }
  const out: OutputOf<"job"> = {
    state: status.state === "DONE" ? "done" : "running",
    job: shown,
    jobState: status.state,
    ...(status.statementType !== undefined ? { statementType: status.statementType } : {}),
    ...(status.totalSlotMs !== undefined ? { slotMs: Number(status.totalSlotMs) } : {}),
    ...(status.totalBytesProcessed !== undefined ? { bytesProcessed: Number(status.totalBytesProcessed) } : {}),
    ...(status.totalBytesBilled !== undefined ? { bytesBilled: Number(status.totalBytesBilled) } : {}),
    ...(status.totalBytesBilled !== undefined ? { costUsd: (Number(status.totalBytesBilled) / 2 ** 40) * context.options.onDemandUsdPerTiB } : {}),
    ...(status.cacheHit !== undefined ? { cacheHit: status.cacheHit } : {}),
  }

  const failure = failureFor(status)
  if (failure) {
    return {
      ...out,
      state: failure.state === "cancelled" ? "cancelled" : "failed",
      error: failure.code,
      message: failure.detail,
      next: failure.next,
      ...(googleErrorText(status.error) ? { googleError: googleErrorText(status.error) } : {}),
    }
  }
  const maxRows = input.maxRows ?? context.options.maxRows
  const wait = input.wait ?? 0

  // The fence, the per-table assert and the policy verdict come before any page is read (review H-1, M-2).
  let gate = await jobGate(status, context)

  // A job still running: `wait` long-polls with getQueryResults, whose answer is the job's own state once it finishes.
  if (status.state !== "DONE") {
    if (wait <= 0) return { ...out, next: jobNext(shown) }
    const polled = await pollJob(context, status.ref, wait, maxRows, input.pageToken, signal)
    if (!polled) return { ...out, next: jobNext(shown) }
    const finished = polled.status
    if (finished.state !== "DONE") return { ...out, next: jobNext(shown) }
    out.state = "done"
    out.jobState = finished.state
    if (finished.statementType !== undefined) out.statementType = finished.statementType
    if (finished.totalBytesProcessed !== undefined) out.bytesProcessed = Number(finished.totalBytesProcessed)
    if (finished.totalBytesBilled !== undefined) out.bytesBilled = Number(finished.totalBytesBilled)
    if (finished.totalBytesBilled !== undefined) out.costUsd = (Number(finished.totalBytesBilled) / 2 ** 40) * context.options.onDemandUsdPerTiB
    if (finished.cacheHit !== undefined) out.cacheHit = finished.cacheHit
    const polledFailure = failureFor(finished)
    if (polledFailure) {
      out.state = polledFailure.state === "cancelled" ? "cancelled" : "failed"
      out.error = polledFailure.code
      out.message = polledFailure.detail
      out.next = polledFailure.next
      return out
    }
    await recordFinishedJob(context, finished)
    // The finished job's referenced lists may carry things the running status did not.
    if (jobObjectKey(finished) !== jobObjectKey(status)) gate = await jobGate(finished, context)
    return withJobRows(out, polled.page, finished, maxRows, gate, context)
  }

  await recordFinishedJob(context, status)
  if (maxRows <= 0 || !RESULT_TYPES.has(status.statementType ?? "")) return out
  let page: ResultPage
  try {
    page = await context.ports.bigquery.results(
      context.account,
      status.ref,
      { timeoutMs: wait * 1000, maxResults: maxRows + 1, ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}) },
      signal,
    )
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") {
      throw new BigQueryError("RESULTS_EXPIRED", "The job's result table is gone", "Run the query again; a result table expires 24 hours after the original run.")
    }
    throw error
  }
  if (!page.complete) return { ...out, next: jobNext(shown) }
  return withJobRows(out, page, status, maxRows, gate, context)
}

/**
 * The row gate for a job (review H-1): the fence and the per-table assert over every object `jobs.get` names, then the
 * policy-tag rule — from the verdict of a query this process prepared, or fail-closed (save-only) for any other job,
 * because its full SQL is not available.
 */
async function jobGate(status: JobStatus, context: HandlerContext) {
  const settings = settingsOf(context.options, context.account)
  const objects = jobObjects(status)
  assertFenced(settings.fence, objects)
  await assertObjectResources({ call: context.call, account: context.account, action: actionOf("job").action, via: "bigquery_job", objects })

  const prepared = jobVerdict(context.ports.clock, context.account, status.ref.jobId)
  const { facts, unknown } = prepared ? { facts: prepared.tables, unknown: false } : await jobTables(context, status)
  const policy: PolicyVerdict = prepared
    ? prepared.policy
    : status.statementType === "SCRIPT" || status.statementType === "CALL"
      ? { inline: false, why: "the job is a script or procedure whose reads this process cannot see" }
      : unknown
        ? { inline: false, why: "the metadata of a table the job references could not be read" }
        : facts.some((table) => table.tagged.length > 0)
          ? { inline: false, why: "the job references a table with policy-tagged columns, and this process did not prepare it" }
          : { inline: true }
  return { ...rowGate({ options: context.options, account: context.account, settings, tables: facts, policy }), facts }
}

/** The page's rows, through the gate; a save-only answer names `bigquery_save`, exactly as `bigquery_query`. */
function withJobRows(out: OutputOf<"job">, page: ResultPage, status: JobStatus, maxRows: number, gate: ReturnType<typeof jobGate> extends Promise<infer T> ? T : never, context: HandlerContext): OutputOf<"job"> {
  const rows = pageOf(page, maxRows, context)
  const warnings = [...((out.warnings as { code: string; message: string }[] | undefined) ?? []), ...gate.warnings]
  return {
    ...out,
    ...(gate.inline ? rows : { ...rows, rows: [], returned: 0 }),
    ...(gate.inline ? {} : { next: saveNext({ project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? "" }) }),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** The job's object list as one comparable string, so a finished job's change is noticed. */
function jobObjectKey(status: JobStatus): string {
  return jobObjects(status)
    .map((object) => `${object.kind}|${object.project}.${object.dataset}.${object.name}`)
    .sort()
    .join(",")
}

/** The objects a job names, as the fence and the per-table assert see them. */
function jobObjects(status: JobStatus): FenceObject[] {
  const out: FenceObject[] = []
  for (const ref of status.referencedTables ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "table" })
  for (const ref of status.referencedLogicalViews ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "view" })
  for (const ref of status.referencedRoutines ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.routineId, kind: "routine" })
  return out
}

/** The tables and views a job names, read for the policy rule; `unknown` when one cannot be read. */
async function jobTables(context: HandlerContext, status: JobStatus): Promise<{ facts: TableFacts[]; unknown: boolean }> {
  const facts: TableFacts[] = []
  const seen = new Set<string>()
  let unknown = false
  const cache = cacheOf<TableInfo>(context.ports.clock, "expand.tables", 60_000, () => context.ports.clock.now())
  for (const ref of [...(status.referencedTables ?? []), ...(status.referencedLogicalViews ?? [])]) {
    const key = `${ref.projectId}.${ref.datasetId}.${ref.tableId}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const cached = cache.get(`${context.account}|${key}`)
      const info = cached ?? (await context.ports.bigquery.getTable(context.account, ref, context.call.signal))
      if (!cached) cache.set(`${context.account}|${key}`, info)
      facts.push(tableFacts(info))
    } catch (error) {
      if (error instanceof BigQueryError && error.code === "NOT_FOUND") unknown = true
      else if (error instanceof BigQueryError && (error.code === "PERMISSION_DENIED" || error.code === "COLUMN_DENIED")) unknown = true
      else throw error
    }
  }
  return { facts, unknown }
}

/** Record a finished job this plugin started, by jobId; the ledger ignores a job it already holds (review M-1). */
async function recordFinishedJob(context: HandlerContext, status: JobStatus): Promise<void> {
  const labels = status.labels ?? {}
  if (labels.oc_plugin !== "opencode-bigquery" || status.state !== "DONE") return
  const billed = status.totalBytesBilled ?? 0
  if (billed <= 0) return
  const via = /^[a-z0-9_-]{1,63}$/.test(labels.oc_tool ?? "") ? labels.oc_tool! : "bigquery_job"
  const session = /^[0-9a-f]{16}$/.test(labels.oc_session ?? "") ? labels.oc_session! : sessionHash(context.call.sessionID)
  try {
    await context.ports.ledger.record({
      at: new Date(status.endTime ?? context.ports.clock.now()).toISOString(),
      account: context.account,
      project: status.ref.projectId,
      location: status.ref.location ?? "",
      jobId: status.ref.jobId,
      bytesBilled: billed,
      via,
      session,
    })
  } catch {
    // A finished job's result must not be lost to a ledger write; the next budget check is the loser by one job.
  }
}

/** The rows and their columns, from one result page. */
function pageOf(page: ResultPage, maxRows: number, context: HandlerContext): Record<string, unknown> {
  const shaped = shapeRows({ schema: page.schema, rows: page.rows, maxRows, maxInlineBytes: context.options.maxInlineBytes })
  return {
    columns: [...shaped.columns],
    rows: shaped.rows.map((row) => [...row]),
    returned: shaped.returned,
    truncated: { ...shaped.truncated },
    ...(page.pageToken !== undefined ? { nextPageToken: page.pageToken } : {}),
    trust: "untrusted" as const,
  }
}

/** A long poll on a running job: its refreshed status and page when it finished, or undefined when the wait ran out. */
async function pollJob(
  context: HandlerContext,
  ref: { readonly projectId: string; readonly jobId: string; readonly location?: string },
  wait: number,
  maxRows: number,
  pageToken: string | undefined,
  signal: AbortSignal,
): Promise<{ status: JobStatus; page: ResultPage } | undefined> {
  let page: ResultPage
  try {
    page = await context.ports.bigquery.results(
      context.account,
      ref,
      { timeoutMs: wait * 1000, maxResults: Math.max(1, Math.min(maxRows, 500)) + 1, ...(pageToken !== undefined ? { pageToken } : {}) },
      signal,
    )
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") {
      throw new BigQueryError("RESULTS_EXPIRED", "The job's result table is gone", "Run the query again; a result table expires 24 hours after the original run.")
    }
    throw error
  }
  if (!page.complete) return undefined
  return { status: await context.ports.bigquery.getJob(context.account, ref, signal), page }
}

// ── bigquery_jobs ────────────────────────────────────────────────────────

const jobs: Handlers["jobs"] = async (input, context) => {
  const settings = settingsOf(context.options, context.account)
  const project = projectOf(settings, input.project)
  const page = await context.ports.bigquery.listJobs(
    {
      account: context.account,
      project,
      ...(input.state !== undefined ? { stateFilter: input.state } : {}),
      maxResults: pageSize(input.limit ?? 50),
      ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
    },
    context.call.signal,
  )
  return {
    state: "done",
    jobs: page.items.map((status) => ({
      job: { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? settings.location ?? "" },
      jobState: status.state,
      ...(status.statementType !== undefined ? { statementType: status.statementType } : {}),
      ...(status.creationTime !== undefined ? { created: new Date(status.creationTime).toISOString() } : {}),
      ...(status.totalBytesBilled !== undefined ? { bytesBilled: Number(status.totalBytesBilled) } : {}),
      ...(status.labels !== undefined ? { labels: { ...status.labels } } : {}),
      ...(status.sqlPreview !== undefined ? { sql: cut(status.sqlPreview, 200) } : {}),
    })),
    ...(page.nextPageToken !== undefined ? { nextPageToken: page.nextPageToken } : {}),
    trust: "untrusted",
  }
}

// ── bigquery_profile ─────────────────────────────────────────────────────

const profile: Handlers["profile"] = async (input, context) => {
  const settings = settingsOf(context.options, context.account)
  const project = projectOf(settings, input.project)
  // The model may only ask; the person's option is what allows a tagged column (review H-2.3). The input is read
  // through a cast, so this keeps working when Day 0 drops `ProfileInput.policyTagged` (contract request 7).
  const requested = (input as { readonly policyTagged?: "allow" }).policyTagged === "allow"
  const allowTagged = requested && context.options.policyTagged === "allow"
  const signal = context.call.signal
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, call: context.call, via: "bigquery_profile" })

  let source: string
  let facts: TableFacts | undefined
  if (input.table !== undefined) {
    const ref = parseTablePath(input.table, project)
    const info = await context.ports.bigquery.getTable(context.account, ref, signal)
    facts = tableFacts(info)
    if (facts.kind !== "data") throw invalid("Only a table or a materialized view is profiled here", "Pass a SELECT to profile instead.")
    source = tableSql(ref)
    if (input.samplePercent !== undefined) {
      if (facts.storage !== "native") throw invalid("TABLESAMPLE needs native BigQuery storage")
      const prober = new RowPolicyProber(
        { ports: context.ports, account: context.account, project, signal },
        cacheOf<RowVerdict>(context.ports.clock, "rowpolicy", 10 * 60_000, () => context.ports.clock.now()),
      )
      const verdict = await prober.probe(facts)
      if (verdict.state !== "none") throw invalid("TABLESAMPLE cannot be combined with a row access policy, and the table may have one")
      source = `${source} TABLESAMPLE SYSTEM (${input.samplePercent} PERCENT)`
    }
  } else {
    source = `(${stripStatement(input.sql!)})`
  }

  const chosen = chooseColumns(input.columns, facts, allowTagged)
  if (chosen.length === 0) {
    throw invalid("No column is left to profile", "Name the columns; a policy-tagged column needs the user's policyTagged option, which the model cannot set.")
  }

  const prepared = await prepareRead(
    rc,
    {
      sql: profileSql(source, chosen, facts !== undefined),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: bytesOf(input.maxBytes) } : {}),
    },
    "read",
  )
  if (!allowTagged && !prepared.policy.inline) {
    throw new BigQueryError(
      "COLUMN_DENIED",
      prepared.policy.why ?? "A profiled column is policy-tagged",
      "Leave that column out; only the plugin's policyTagged option, which the user sets, can allow a tagged column.",
    )
  }
  const run = await runRead(rc, prepared, { maxRows: chosen.length, waitSeconds: 30 })
  if (run.state === "running") throw new BigQueryError("JOB_TIMEOUT", "The profile query is still running", "Run the aggregate yourself with bigquery_query, or try again.")
  if (run.state === "failed") throw new BigQueryError(run.failure!.code, run.failure!.detail, run.failure!.next)

  return {
    state: "done",
    columns: (run.rows ?? []).map(profileRow),
    bytesProcessed: run.bytesProcessed,
    bytesBilled: run.bytesBilled,
    costUsd: run.usd,
    cacheHit: run.cacheHit,
    job: run.job,
    ...(run.warnings.length > 0 ? { warnings: [...run.warnings] } : {}),
    trust: "untrusted",
  }
}

function profileRow(row: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = { column: typeof row[0] === "string" ? row[0] : "" }
  const number = (value: unknown) => (typeof value === "number" ? value : undefined)
  const nulls = number(row[1])
  const distinct = number(row[2])
  if (nulls !== undefined) out.nulls = nulls
  if (distinct !== undefined) out.distinctApprox = distinct
  if (row[3] !== undefined && row[3] !== null) out.min = row[3]
  if (row[4] !== undefined && row[4] !== null) out.max = row[4]
  const quantiles = parseJson(row[5])
  if (quantiles !== undefined) out.quantiles = quantiles
  const top = parseJson(row[6])
  if (top !== undefined) out.top = top
  return out
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function chooseColumns(requested: readonly string[] | undefined, facts: TableFacts | undefined, allowTagged: boolean): { name: string; type?: string; repeated?: boolean }[] {
  if (facts === undefined) {
    if (requested === undefined || requested.length === 0) throw invalid("Profiling a SELECT needs the columns to profile", "Pass columns, because a SELECT's result schema is not known before it runs.")
    return requested.map((name) => ({ name }))
  }
  if (requested !== undefined) {
    for (const name of requested) {
      const field = facts.columns.find((item) => item.name === name)
      if (!field) throw invalid(`The table has no column named ${column(name, 1)} in its schema`)
      if (!allowTagged && facts.tagged.includes(field.name)) {
        throw new BigQueryError(
          "COLUMN_DENIED",
          `The column ${column(name, 1)} of the table ${path(facts.project, facts.dataset, facts.table)} is policy-tagged`,
          "Leave it out; only the plugin's policyTagged option, which the user sets, can allow a tagged column.",
        )
      }
    }
    return requested.map((name) => {
      const column = facts.columns.find((item) => item.name === name)
      return { name, ...(column?.type !== undefined ? { type: column.type } : {}), ...(column?.mode === "REPEATED" ? { repeated: true } : {}) }
    })
  }
  return facts.columns.filter((field) => !isStruct(field) && (allowTagged || !facts.tagged.includes(field.name))).map((field) => ({ name: field.name, type: field.type, ...(field.mode === "REPEATED" ? { repeated: true } : {}) }))
}

/**
 * One query with one `UNION ALL` arm per column: nulls, distinct, min/max, quantiles and the top five values. An arm over
 * a table source reads the table once per arm, and `TABLESAMPLE` draws per arm; the dry run is what bounds the cost.
 */
function profileSql(source: string, columns: readonly { name: string; type?: string; repeated?: boolean }[], typed: boolean): string {
  const arms = columns.map((entry) => {
    const ident = quoteIdent(entry.name)
    const label = quoteLiteral(entry.name)
    const type = entry.type?.toUpperCase()
    const known = typed && type !== undefined
    const complex = known && (type === "STRUCT" || type === "RECORD" || type === "JSON")
    const repeated = entry.repeated === true || (known && type === "ARRAY")
    // Every arm of the UNION ALL needs the same type, so a "no value" arm carries an explicit CAST rather than a bare
    // NULL, whose type BigQuery infers as INT64.
    const text = (expression: string) => (type === "BYTES" ? `SAFE_CONVERT_BYTES_TO_STRING(${expression})` : `CAST(${expression} AS STRING)`)
    const noneText = "CAST(NULL AS STRING)"
    const nulls = complex ? "CAST(NULL AS INT64)" : `COUNTIF(${ident} IS NULL)`
    const distinct = complex || repeated ? "CAST(NULL AS INT64)" : `APPROX_COUNT_DISTINCT(${text(ident)})`
    const orderable = !known || isOrderable(type!)
    const min = complex || repeated || !orderable ? noneText : text(`MIN(${ident})`)
    const max = complex || repeated || !orderable ? noneText : text(`MAX(${ident})`)
    const quantiles = known && NUMERIC_TYPES.has(type!) && !repeated ? `TO_JSON(APPROX_QUANTILES(${ident}, 4))` : noneText
    const groupable = !known || GROUPABLE.has(type!)
    const top = complex || repeated || !groupable ? noneText : `TO_JSON(APPROX_TOP_COUNT(${ident}, 5))`
    return `SELECT ${label} AS column_name, ${nulls} AS nulls, ${distinct} AS distinct_approx, ${min} AS min_value, ${max} AS max_value, ${quantiles} AS quantiles, ${top} AS top_values FROM ${source}`
  })
  return arms.join("\nUNION ALL\n")
}

// ── shared ───────────────────────────────────────────────────────────────

function isoTime(value: string): string {
  const number = Number(value)
  return Number.isFinite(number) ? new Date(number).toISOString() : value
}

function parseTablePath(table: string, fallbackProject: string): TableReference {
  const parts = table.split(".")
  if (parts.length < 2 || parts.some((part) => part.length === 0)) throw invalid("The table path needs project.dataset.table, or dataset.table")
  if (parts.length === 2) return { projectId: fallbackProject, datasetId: parts[0]!, tableId: parts[1]! }
  return { projectId: parts[0]!, datasetId: parts[1]!, tableId: parts.slice(2).join(".") }
}

/** A statement passed as a source: one SELECT, with its trailing semicolon removed and no second statement. */
function stripStatement(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "")
  const lexed = createLexer().lex(trimmed)
  if (lexed.ok) {
    const tokens = lexed.tokens.filter((token) => token.kind !== "comment")
    if (tokens.some((token) => token.kind === "punctuation" && token.text === ";")) {
      throw invalid("The source must be one SELECT, without another statement", "Profile a table instead, or reduce the SELECT to one statement.")
    }
  }
  return trimmed
}

export const READ_HANDLERS: Pick<Handlers, "list" | "table" | "search" | "estimate" | "query" | "job" | "jobs" | "profile"> = {
  list,
  table,
  search,
  estimate,
  query,
  job,
  jobs,
  profile,
}
