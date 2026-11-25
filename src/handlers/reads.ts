/**
 * The reading methods: `list`, `table`, `search`, `estimate`, `query`, `job`, `jobs` and `profile` (design §4). Everything
 * billed goes through the read path (`prepareRead` + `runRead`), so a search's `INFORMATION_SCHEMA` read, a table's
 * partitions and a profile are guarded exactly like a query: dry run first, the statement type, expansion, the fence, the
 * cap and the policy-tag rule.
 *
 * The register has already resolved the account and asserted the method's declared operations. Nothing here builds a
 * `message` or a `next` from Google's text or from a row: a name in one comes from `src/domain/identifiers.ts`.
 */

import { queryResult, type ReadRunAnswer } from "../changes/commit.js";
import { BigQueryError } from "../domain/errors.js";
import type { RoutineInfo, SchemaField, TableInfo, TableReference } from "../domain/google.js";
import { column, path } from "../domain/identifiers.js";
import { cacheOf } from "../guards/cache.js";
import type { FenceObject } from "../guards/fence.js";
import { assertFenced, isFenced } from "../guards/fence.js";
import { failureFor } from "../guards/jobfail.js";
import { createLexer } from "../guards/lexer.js";
import { type PolicyVerdict, policyVerdict } from "../guards/policy.js";
import { jobVerdict, type PreparedRead, prepareRead, type ReadContext, type ReadRun, readContext, runRead, saveNext } from "../guards/read.js";
import { cellValue, rowValues, shapeRows } from "../guards/results.js";
import { RowPolicyProber, type RowVerdict } from "../guards/rowpolicy.js";
import { rowGate } from "../guards/rows.js";
import { sessionHash } from "../guards/session.js";
import { locationOf, projectOf, settingsOf } from "../guards/settings.js";
import { quoteIdent, quoteLiteral, tableSql } from "../guards/sql.js";
import { flattenSchema, GROUPABLE, isOrderable, isStruct, NUMERIC_TYPES, type TableFacts, tableFacts } from "../guards/tables.js";
import { parseBytes } from "../options.js";
import type { JobStatus, ResultPage } from "../ports.js";
import type { HandlerContext } from "./context.js";

const invalid = (detail: string, next?: string) => new BigQueryError("INPUT_INVALID", detail, next);

/** The page size for a list call: the caller's limit, within Google's maximum. */
const pageSize = (limit: number) => Math.max(1, Math.min(limit, 1_000));

/** Whether a list item matches the call's filter, case-insensitively. */
const matches = (values: readonly (string | undefined)[], filter: string | undefined) =>
  filter === undefined || values.some((value) => value !== undefined && value.toLowerCase().includes(filter.toLowerCase()));

const cut = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A byte size from the input: a number, or a string such as `512MiB`. */
const bytesOf = (value: string | number) => (typeof value === "number" ? value : parseBytes(value));

// ── list ─────────────────────────────────────────────────────────────────

export interface ListInput {
  readonly project?: string;
  readonly dataset?: string;
  readonly kind?: "tables" | "routines";
  readonly filter?: string;
  readonly details?: boolean;
  readonly limit?: number;
  readonly pageToken?: string;
}

export async function list(input: ListInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const settings = settingsOf(context.options, context.account);
  const limit = input.limit ?? 100;
  const page = { account: context.account, ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}), maxResults: pageSize(limit) };

  if (input.dataset !== undefined && input.project === undefined) throw invalid("A dataset belongs to a project: pass project with dataset", "Pass the project id the dataset is in.");
  if (input.kind === "routines" && input.dataset === undefined) throw invalid("kind: routines lists a dataset's routines: pass dataset", "Pass the dataset whose routines to list.");

  if (input.project === undefined) {
    const answer = await context.ports.bigquery.listProjects(page, context.signal);
    const items = answer.items
      .filter((project) => matches([project.projectId, project.friendlyName], input.filter))
      .map((project) => ({ project: project.projectId, ...(project.friendlyName !== undefined ? { name: cut(project.friendlyName) } : {}) }));
    return { items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" };
  }

  const project = projectOf(settings, input.project);
  if (input.dataset === undefined) {
    const answer = await context.ports.bigquery.listDatasets({ ...page, project }, context.signal);
    const items = answer.items
      .filter((dataset) => matches([dataset.ref.datasetId], input.filter))
      .map((dataset) => ({ project, dataset: dataset.ref.datasetId, ...(dataset.location !== undefined ? { location: dataset.location } : {}) }));
    return { items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" };
  }

  const dataset = { projectId: project, datasetId: input.dataset };
  if (input.kind === "routines") {
    const answer = await context.ports.bigquery.listRoutines({ ...page, dataset }, context.signal);
    const items = answer.items.filter((routine) => matches([routine.routineReference.routineId], input.filter)).map(routineItem);
    return { items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" };
  }

  const answer = await context.ports.bigquery.listTables({ ...page, dataset }, context.signal);
  const kept = answer.items.filter((table) => matches([table.tableReference.tableId, table.description], input.filter));
  const items: Record<string, unknown>[] = kept.map(tableItem);
  if (input.details === true) {
    for (const [index, table] of kept.slice(0, 25).entries()) {
      const info = await context.ports.bigquery.getTable(context.account, table.tableReference, context.signal);
      items[index] = { ...items[index], ...detailsOf(info) };
    }
  }
  return { items, ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}), trust: "untrusted" };
}

function tableItem(table: TableInfo): Record<string, unknown> {
  const ref = table.tableReference;
  return {
    project: ref.projectId,
    dataset: ref.datasetId,
    table: ref.tableId,
    ...(table.type !== undefined ? { type: table.type } : {}),
    ...(table.location !== undefined ? { location: table.location } : {}),
    ...(table.timePartitioning !== undefined || table.rangePartitioning !== undefined ? { partitioned: true } : {}),
    ...(table.clustering?.fields !== undefined ? { clustered: true } : {}),
    ...(table.description !== undefined ? { description: cut(table.description) } : {}),
  };
}

function routineItem(routine: RoutineInfo): Record<string, unknown> {
  const ref = routine.routineReference;
  return {
    project: ref.projectId,
    dataset: ref.datasetId,
    routine: ref.routineId,
    ...(routine.routineType !== undefined ? { type: routine.routineType } : {}),
    ...(routine.language !== undefined ? { language: routine.language } : {}),
    remote: routine.remoteFunctionOptions !== undefined,
    ...(routine.arguments !== undefined ? { arguments: routine.arguments.length } : {}),
  };
}

function detailsOf(info: TableInfo): Record<string, unknown> {
  return {
    ...(info.numRows !== undefined ? { rows: Number(info.numRows) } : {}),
    ...(info.numBytes !== undefined ? { bytes: Number(info.numBytes) } : {}),
    ...(info.lastModifiedTime !== undefined ? { modified: isoTime(info.lastModifiedTime) } : {}),
  };
}

// ── table ────────────────────────────────────────────────────────────────

export interface TableInput {
  readonly project?: string;
  readonly dataset: string;
  readonly table: string;
  readonly sample?: number;
  readonly partitions?: boolean;
}

export async function table(input: TableInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const settings = settingsOf(context.options, context.account);
  const project = projectOf(settings, input.project);
  const ref = { projectId: project, datasetId: input.dataset, tableId: input.table };
  const info = await context.ports.bigquery.getTable(context.account, ref, context.signal);
  const facts = tableFacts(info);
  const viewSql = info.view?.query ?? info.materializedView?.query;

  const out: Record<string, unknown> = {
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
  };

  if (input.sample !== undefined && input.sample > 0) {
    // A sample reads rows, so it is a data read: the fence applies before tabledata.list, exactly as for a query.
    assertFenced(settings.fence, [{ project, dataset: input.dataset, name: input.table, kind: "table" }]);
    Object.assign(out, await sampleRows(facts, input.sample, context));
  }
  if (input.partitions === true) Object.assign(out, await partitionsOf(project, input.dataset, input.table, context));
  return out;
}

async function sampleRows(facts: TableFacts, rows: number, context: HandlerContext): Promise<Record<string, unknown>> {
  const unavailable = (why: string) => ({ sample: { unavailable: why } });
  if (facts.kind === "view") return unavailable("A view has no stored rows to sample");
  if (facts.kind !== "data") return unavailable("Only a native table has rows this method samples");
  if (facts.columns.length === 0) return unavailable("The table's schema names no column to read");
  const readable = facts.columns.filter((field) => !facts.tagged.includes(field.name));
  if (readable.length === 0) return unavailable("Every column of the table is policy-tagged");
  // The shared row gate: the inline option covers every row that would reach the model, a sample included.
  const gate = rowGate({ options: context.options, account: context.account, settings: settingsOf(context.options, context.account), tables: [facts], policy: { inline: true } });
  if (!gate.inline) return { ...unavailable("The account's inline option makes this dataset save-only"), warnings: [...gate.warnings] };

  const prober = new RowPolicyProber({ ports: context.ports, account: context.account, project: facts.project, signal: context.signal }, cacheOf<RowVerdict>(context.ports.clock, "rowpolicy", 10 * 60_000, () => context.ports.clock.now()));
  const verdict = await prober.probe(facts);
  if (verdict.state === "secured") return unavailable("The table has a row access policy, so a sample could show rows the caller may not read");
  if (verdict.state === "unknown") return unavailable("The row-access check on the table could not be completed");

  let page: ResultPage;
  try {
    page = await context.ports.bigquery.listTableData(context.account, facts.info.tableReference, { maxResults: rows, selectedFields: readable.map((field) => field.name) }, context.signal);
  } catch (error) {
    if (error instanceof BigQueryError && (error.code === "PERMISSION_DENIED" || error.code === "COLUMN_DENIED")) return unavailable("The table refused the sample");
    throw error;
  }
  return {
    sample: shapeSample(page, readable, rows, context.options.maxInlineBytes),
    ...(facts.tagged.length > 0 ? { withheld: [...facts.tagged] } : {}),
  };
}

/** The sample as the method's own shape: arrays in the readable columns' order, with the query method's cell rules. */
function shapeSample(page: ResultPage, fields: readonly SchemaField[], maxRows: number, maxInlineBytes: number): unknown[][] {
  const rows: unknown[][] = [];
  let used = 0;
  for (const raw of page.rows.slice(0, maxRows)) {
    const shaped = rowValues(raw).map((value, index) => cellValue(value, fields[index]).value);
    const size = Buffer.byteLength(JSON.stringify(shaped) ?? "");
    if (rows.length > 0 && used + size > maxInlineBytes) break;
    used += size;
    rows.push(shaped);
  }
  return rows;
}

async function partitionsOf(project: string, dataset: string, table: string, context: HandlerContext): Promise<Record<string, unknown>> {
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: "table" });
  const sql = `SELECT table_name, partition_id, total_rows, total_billable_bytes, last_modified_time FROM ${quoteIdent(project)}.${quoteIdent(dataset)}.INFORMATION_SCHEMA.PARTITIONS WHERE table_name = @table ORDER BY partition_id LIMIT 1000`;
  const prepared = await prepareRead(rc, { sql, params: { table }, project }, "read");
  const run = await runRead(rc, prepared, { maxRows: 1_000, waitSeconds: 240 });
  if (run.state === "running") throw new BigQueryError("JOB_TIMEOUT", "The partitions query is still running", "Run the same query with query, or wait and try the table again.");
  if (run.state === "failed") throw new BigQueryError(run.failure!.code, run.failure!.detail, run.failure!.next);
  return {
    partitions: (run.rows ?? []).map((row) => ({
      partition: String(row[1] ?? ""),
      rows: Number(row[2] ?? 0),
      bytes: Number(row[3] ?? 0),
      ...(row[4] !== undefined && row[4] !== null ? { modified: String(row[4]) } : {}),
    })),
    ...(run.warnings.length > 0 ? { warnings: [...run.warnings] } : {}),
  };
}

function partitioningOf(info: TableInfo): Record<string, unknown> | undefined {
  const time = info.timePartitioning;
  if (time !== undefined) {
    return {
      type: time.type ?? "DAY",
      ...(time.field !== undefined ? { field: time.field } : {}),
      requirePartitionFilter: info.requirePartitionFilter === true || time.requirePartitionFilter === true,
    };
  }
  const range = info.rangePartitioning;
  if (range !== undefined) {
    return { type: "RANGE", ...(range.field !== undefined ? { field: range.field } : {}), ...(range.range !== undefined ? { range: { ...range.range } } : {}), requirePartitionFilter: info.requirePartitionFilter === true };
  }
  if (info.requirePartitionFilter === true) return { type: "INGESTION", requirePartitionFilter: true };
  return undefined;
}

// ── search ───────────────────────────────────────────────────────────────

/** At most this many datasets are searched through their own views before falling back to names. */
const SEARCH_DATASETS = 10;

type Found = { table: { project: string; dataset: string; table: string }; column?: string; where: "name" | "description" };

export interface SearchInput {
  readonly project?: string;
  readonly location?: string;
  readonly query: string;
  readonly limit?: number;
}

export async function search(input: SearchInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const settings = settingsOf(context.options, context.account);
  const project = projectOf(settings, input.project);
  const limit = input.limit ?? 50;
  const location = locationOf(settings, input.location);
  const needle = input.query.toLowerCase();
  const pattern = `%${escapeLike(needle)}%`;
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: "search" });

  // 1. The region-qualified view: one read covering this project's region.
  if (location !== undefined) {
    try {
      const sql = `SELECT table_catalog, table_schema, table_name, column_name, field_path, description FROM \`region-${location.toLowerCase()}\`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS WHERE LOWER(table_name) LIKE @q OR LOWER(column_name) LIKE @q OR LOWER(IFNULL(description, '')) LIKE @q LIMIT ${Math.max(1, Math.min(limit, 200))}`;
      const out = await searchRead(rc, project, sql, pattern, limit, needle);
      if (out.matches.length > 0) return { matches: out.matches, via: "region", ...cost(out.processed, out.billed), trust: "untrusted" };
    } catch (error) {
      if (!fallbackable(error)) throw error;
    }
  }

  // 2. Each dataset's own view: at least 10 MiB each, so the fence's datasets come first and at most ten run.
  const datasets = await searchDatasets(context, project, settings.fence);
  const found: Found[] = [];
  let processed = 0;
  let billed = 0;
  for (const dataset of datasets) {
    if (found.length >= limit) break;
    try {
      const sql = `SELECT table_catalog, table_schema, table_name, column_name, field_path, description FROM ${quoteIdent(dataset.project)}.${quoteIdent(dataset.dataset)}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS WHERE LOWER(table_name) LIKE @q OR LOWER(column_name) LIKE @q OR LOWER(IFNULL(description, '')) LIKE @q LIMIT ${Math.max(1, Math.min(limit - found.length, 200))}`;
      const out = await searchRead(rc, project, sql, pattern, limit - found.length, needle);
      processed += out.processed;
      billed += out.billed;
      found.push(...out.matches);
    } catch (error) {
      if (!fallbackable(error)) throw error;
    }
  }
  if (found.length > 0) return { matches: found, via: "dataset", ...cost(processed, billed), trust: "untrusted" };

  // 3. Plain table names: free, and the honest answer when the views are not readable.
  const names = await searchNames(context, project, datasets, needle, limit, settings.fence);
  return { matches: names, via: "names", trust: "untrusted" };
}

async function searchRead(rc: ReadContext, project: string, sql: string, pattern: string, limit: number, needle: string): Promise<{ matches: Found[]; processed: number; billed: number }> {
  const prepared = await prepareRead(rc, { sql, params: { q: pattern }, project }, "read");
  const run = await runRead(rc, prepared, { maxRows: Math.max(1, Math.min(limit, 200)), waitSeconds: 30 });
  if (run.state === "running") throw new BigQueryError("JOB_TIMEOUT", "The search query is still running", "Try the search again in a moment.");
  if (run.state === "failed") throw new BigQueryError(run.failure!.code, run.failure!.detail, run.failure!.next);
  return {
    matches: foundRows(run, needle).filter((found) => !isFenced(rc.settings.fence, { project: found.table.project, dataset: found.table.dataset, name: found.table.table, kind: "table" })),
    processed: run.bytesProcessed,
    billed: run.bytesBilled,
  };
}

function foundRows(run: ReadRun, needle: string): Found[] {
  const out: Found[] = [];
  for (const row of run.rows ?? []) {
    const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));
    const project = text(row[0]);
    const dataset = text(row[1]);
    const table = text(row[2]);
    if (table === "" || dataset === "") continue;
    const name = text(row[3]);
    const field = text(row[4]) || name;
    const byColumn = field.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
    out.push({
      table: { project, dataset, table },
      ...(field !== "" && field.toLowerCase() !== table.toLowerCase() ? { column: field } : {}),
      where: byColumn || table.toLowerCase().includes(needle) ? "name" : "description",
    });
  }
  return out;
}

async function searchDatasets(context: HandlerContext, project: string, fence: ReturnType<typeof settingsOf>["fence"]): Promise<{ project: string; dataset: string }[]> {
  const named = (fence?.allow ?? [])
    .filter((pattern) => !pattern.includes("*"))
    .map((pattern) => {
      const [owner, dataset] = pattern.split(".");
      return { project: owner ?? project, dataset: dataset ?? "" };
    })
    .filter((entry) => entry.dataset !== "");
  if (named.length > 0) return named.slice(0, SEARCH_DATASETS);
  const page = await context.ports.bigquery.listDatasets({ account: context.account, project, maxResults: SEARCH_DATASETS }, context.signal);
  return page.items.slice(0, SEARCH_DATASETS).map((dataset) => ({ project, dataset: dataset.ref.datasetId }));
}

async function searchNames(context: HandlerContext, project: string, datasets: readonly { project: string; dataset: string }[], needle: string, limit: number, fence: ReturnType<typeof settingsOf>["fence"]): Promise<Found[]> {
  const out: Found[] = [];
  for (const dataset of datasets) {
    if (out.length >= limit) break;
    try {
      const page = await context.ports.bigquery.listTables(
        { account: context.account, dataset: { projectId: dataset.project || project, datasetId: dataset.dataset }, maxResults: 200 },
        context.signal,
      );
      for (const table of page.items) {
        if (out.length >= limit) break;
        const inName = table.tableReference.tableId.toLowerCase().includes(needle);
        const inDescription = table.description !== undefined && table.description.toLowerCase().includes(needle);
        if (!inName && !inDescription) continue;
        if (isFenced(fence, { project: dataset.project || project, dataset: dataset.dataset, name: table.tableReference.tableId, kind: "table" })) continue;
        out.push({ table: { project: dataset.project || project, dataset: dataset.dataset, table: table.tableReference.tableId }, where: inName ? "name" : "description" });
      }
    } catch (error) {
      if (error instanceof BigQueryError && (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED")) continue;
      throw error;
    }
  }
  return out;
}

const cost = (processed: number, billed: number) => ({ bytesProcessed: processed, bytesBilled: billed });

/** A LIKE pattern from the caller's words: the wildcards are the plugin's, not the input's. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** An error a search falls back from: a view the caller may not read, a fence, a plan, or a missing view. */
function fallbackable(error: unknown): boolean {
  if (!(error instanceof BigQueryError)) return false;
  return ["PERMISSION_DENIED", "COLUMN_DENIED", "DATASET_FENCED", "NEEDS_PLAN", "CAP_NOT_ENFORCEABLE", "NOT_FOUND", "SQL_INVALID"].includes(error.code);
}

// ── estimate ─────────────────────────────────────────────────────────────

export interface EstimateInput {
  readonly sql: string;
  readonly params?: Readonly<Record<string, unknown>> | readonly unknown[];
  readonly project?: string;
  readonly location?: string;
}

export async function estimate(input: EstimateInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: "estimate" });
  const prepared = await prepareRead(
    rc,
    {
      sql: input.sql,
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
    },
    "inspect",
  );
  const statistics = prepared.statistics;
  return {
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
    trust: "untrusted",
  };
}

// ── query ────────────────────────────────────────────────────────────────

export interface QueryInput {
  readonly sql: string;
  readonly params?: Readonly<Record<string, unknown>> | readonly unknown[];
  readonly project?: string;
  readonly location?: string;
  readonly maxBytes?: string | number;
  readonly maxRows?: number;
  readonly wait?: number;
  readonly useCache?: boolean;
}

/** One bounded read: a dry run, the guards, then the run. A read the cap cannot bound belongs to plan_query. */
export async function query(input: QueryInput, context: HandlerContext): Promise<ReadRunAnswer> {
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: "query" });
  const prepared = await prepareRead(
    rc,
    {
      sql: input.sql,
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: bytesOf(input.maxBytes) } : {}),
      ...(input.useCache !== undefined ? { useCache: input.useCache } : {}),
    },
    "read",
  );
  const run = await runRead(rc, prepared, { maxRows: input.maxRows ?? context.options.maxRows, waitSeconds: input.wait ?? 30 });
  await context.bus.emit("changed", { capability: "bigquery.jobs", account: context.account, reason: "read" });
  return queryResult(prepared, run);
}

// ── job ──────────────────────────────────────────────────────────────────

/** The statement types whose jobs have result rows to page through. */
const RESULT_TYPES = new Set(["SELECT", "ASSERT", "SCRIPT", "CALL"]);

export interface JobInput {
  readonly project?: string;
  readonly jobId: string;
  readonly location?: string;
  readonly wait?: number;
  readonly maxRows?: number;
  readonly pageToken?: string;
}

export async function job(input: JobInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const settings = settingsOf(context.options, context.account);
  const project = projectOf(settings, input.project);
  const location = locationOf(settings, input.location);
  const ref = { projectId: project, jobId: input.jobId, ...(location !== undefined ? { location } : {}) };
  const status = await context.ports.bigquery.getJob(context.account, ref, context.signal);
  const shown = { project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? location ?? "" };
  const out: Record<string, unknown> = {
    job: shown,
    jobState: status.state,
    ...(status.statementType !== undefined ? { statementType: status.statementType } : {}),
    ...(status.totalSlotMs !== undefined ? { slotMs: Number(status.totalSlotMs) } : {}),
    ...(status.totalBytesProcessed !== undefined ? { bytesProcessed: Number(status.totalBytesProcessed) } : {}),
    ...(status.totalBytesBilled !== undefined ? { bytesBilled: Number(status.totalBytesBilled) } : {}),
    ...(status.totalBytesBilled !== undefined ? { costUsd: (Number(status.totalBytesBilled) / 2 ** 40) * context.options.onDemandUsdPerTiB } : {}),
    ...(status.cacheHit !== undefined ? { cacheHit: status.cacheHit } : {}),
    trust: "untrusted",
  };

  const failure = failureFor(status);
  if (failure) throw failure;
  const maxRows = input.maxRows ?? context.options.maxRows;
  const wait = input.wait ?? 0;

  // The fence and the policy verdict come before any page is read.
  let gate = await jobGate(status, context);

  // A job still running: `wait` long-polls with getQueryResults, whose answer is the job's own state once it finishes.
  if (status.state !== "DONE") {
    if (wait <= 0) return { ...out, next: jobNext(shown) };
    const polled = await pollJob(context, status.ref, wait, maxRows, input.pageToken);
    if (!polled || polled.status.state !== "DONE") return { ...out, next: jobNext(shown) };
    const finished = polled.status;
    Object.assign(out, {
      jobState: finished.state,
      ...(finished.statementType !== undefined ? { statementType: finished.statementType } : {}),
      ...(finished.totalBytesProcessed !== undefined ? { bytesProcessed: Number(finished.totalBytesProcessed) } : {}),
      ...(finished.totalBytesBilled !== undefined ? { bytesBilled: Number(finished.totalBytesBilled) } : {}),
      ...(finished.totalBytesBilled !== undefined ? { costUsd: (Number(finished.totalBytesBilled) / 2 ** 40) * context.options.onDemandUsdPerTiB } : {}),
      ...(finished.cacheHit !== undefined ? { cacheHit: finished.cacheHit } : {}),
    });
    const polledFailure = failureFor(finished);
    if (polledFailure) throw new BigQueryError(polledFailure.code, polledFailure.detail, polledFailure.next);
    await recordFinishedJob(context, finished);
    if (jobObjectKey(finished) !== jobObjectKey(status)) gate = await jobGate(finished, context);
    return withJobRows(out, polled.page, finished, maxRows, gate, context);
  }

  await recordFinishedJob(context, status);
  if (maxRows <= 0 || !RESULT_TYPES.has(status.statementType ?? "")) return out;
  let page: ResultPage;
  try {
    page = await context.ports.bigquery.results(context.account, status.ref, { timeoutMs: wait * 1000, maxResults: maxRows + 1, ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}) }, context.signal);
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") {
      throw new BigQueryError("RESULTS_EXPIRED", "The job's result table is gone", "Run the query again; a result table expires 24 hours after the original run.");
    }
    throw error;
  }
  if (!page.complete) return { ...out, next: jobNext(shown) };
  return withJobRows(out, page, status, maxRows, gate, context);
}

/**
 * The row gate for a job: the fence over every object `jobs.get` names, then the policy-tag rule — the verdict of a query
 * this process prepared, or fail-closed (save-only) for any other job, because its full SQL and its views' and routines'
 * bodies have not been analysed.
 *
 * Google's `INFORMATION_SCHEMA.JOBS` reference says the referenced lists are "only populated for query jobs that are not
 * cache hits", so an unprepared cache hit that names nothing proves nothing: it is save-only, and with a fence set it is
 * refused, because the fence cannot be checked.
 */
async function jobGate(status: JobStatus, context: HandlerContext) {
  const settings = settingsOf(context.options, context.account);
  const objects = jobObjects(status);
  const prepared = jobVerdict(context.ports.clock, context.account, status.ref.jobId);
  const blind = prepared === undefined && status.cacheHit === true && objects.length === 0;
  if (blind && (settings.fence?.allow !== undefined || settings.fence?.deny !== undefined)) {
    throw new BigQueryError(
      "DATASET_FENCED",
      "The job's result came from the query cache, so BigQuery names none of the objects it read and the account's dataset fence cannot be checked",
      "Run the query with query, which checks it before it runs.",
    );
  }
  assertFenced(settings.fence, objects);

  const { facts, unknown } = prepared ? { facts: [...prepared.tables, ...prepared.views], unknown: false } : await jobTables(context, status);
  const policy: PolicyVerdict = prepared
    ? prepared.policy
    : status.statementType === "SCRIPT" || status.statementType === "CALL"
      ? { inline: false, why: "the job is a script or procedure whose reads this process cannot see" }
      : blind
        ? { inline: false, why: "the job's result came from the query cache, so BigQuery names none of the tables it read" }
        : (status.referencedLogicalViews?.length ?? 0) > 0 || (status.referencedRoutines?.length ?? 0) > 0
          ? { inline: false, why: "the job reads a view or a routine whose body this process has not analysed" }
          : unknown
            ? { inline: false, why: "the metadata of a table the job references could not be read" }
            : policyVerdict({ tables: facts, mode: context.options.policyTagged });
  return { ...rowGate({ options: context.options, account: context.account, settings, tables: facts, policy }), facts };
}

/** The page's rows, through the gate; a save-only answer names `save`, exactly as `query`. */
function withJobRows(out: Record<string, unknown>, page: ResultPage, status: JobStatus, maxRows: number, gate: Awaited<ReturnType<typeof jobGate>>, context: HandlerContext): Record<string, unknown> {
  const rows = pageOf(page, maxRows, context);
  const warnings = [...((out.warnings as { code: string; message: string }[] | undefined) ?? []), ...gate.warnings];
  return {
    ...out,
    ...(gate.inline ? rows : { ...rows, rows: [], returned: 0 }),
    ...(gate.inline ? {} : { next: saveNext({ project: status.ref.projectId, jobId: status.ref.jobId, location: status.ref.location ?? "" }) }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The job's object list as one comparable string, so a finished job's change is noticed. */
function jobObjectKey(status: JobStatus): string {
  return jobObjects(status)
    .map((object) => `${object.kind}|${object.project}.${object.dataset}.${object.name}`)
    .sort()
    .join(",");
}

/** The objects a job names, as the fence sees them. */
function jobObjects(status: JobStatus): FenceObject[] {
  const out: FenceObject[] = [];
  for (const ref of status.referencedTables ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "table" });
  for (const ref of status.referencedLogicalViews ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, kind: "view" });
  for (const ref of status.referencedRoutines ?? []) out.push({ project: ref.projectId, dataset: ref.datasetId, name: ref.routineId, kind: "routine" });
  return out;
}

/** The tables and views a job names, read for the policy rule; `unknown` when one cannot be read. */
async function jobTables(context: HandlerContext, status: JobStatus): Promise<{ facts: TableFacts[]; unknown: boolean }> {
  const facts: TableFacts[] = [];
  const seen = new Set<string>();
  let unknown = false;
  const cache = cacheOf<TableInfo>(context.ports.clock, "expand.tables", 60_000, () => context.ports.clock.now());
  for (const ref of [...(status.referencedTables ?? []), ...(status.referencedLogicalViews ?? [])]) {
    const key = `${ref.projectId}.${ref.datasetId}.${ref.tableId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const cached = cache.get(`${context.account}|${key}`);
      const info = cached ?? (await context.ports.bigquery.getTable(context.account, ref, context.signal));
      if (!cached) cache.set(`${context.account}|${key}`, info);
      facts.push(tableFacts(info));
    } catch (error) {
      if (error instanceof BigQueryError && (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED" || error.code === "COLUMN_DENIED")) unknown = true;
      else throw error;
    }
  }
  return { facts, unknown };
}

/** Record a finished job this plugin started, by jobId; the ledger ignores a job it already holds. */
async function recordFinishedJob(context: HandlerContext, status: JobStatus): Promise<void> {
  const labels = status.labels ?? {};
  if (labels.oc_plugin !== "bigquery-plugin" || status.state !== "DONE") return;
  const billed = status.totalBytesBilled ?? 0;
  if (billed <= 0) return;
  const via = /^[a-z0-9_-]{1,63}$/.test(labels.oc_tool ?? "") ? labels.oc_tool! : "job";
  const session = /^[0-9a-f]{16}$/.test(labels.oc_session ?? "") ? labels.oc_session! : sessionHash(context.sessionID);
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
    });
  } catch {
    // A finished job's result must not be lost to a ledger write; the next budget check is the loser by one job.
  }
}

/** The rows and their columns, from one result page. */
function pageOf(page: ResultPage, maxRows: number, context: HandlerContext): Record<string, unknown> {
  const shaped = shapeRows({ schema: page.schema, rows: page.rows, maxRows, maxInlineBytes: context.options.maxInlineBytes });
  return {
    columns: [...shaped.columns],
    rows: shaped.rows.map((row) => [...row]),
    returned: shaped.returned,
    truncated: { ...shaped.truncated },
    ...(page.pageToken !== undefined ? { nextPageToken: page.pageToken } : {}),
    trust: "untrusted" as const,
  };
}

/** A long poll on a running job: its refreshed status and page when it finished, or undefined when the wait ran out. */
async function pollJob(context: HandlerContext, ref: { readonly projectId: string; readonly jobId: string; readonly location?: string }, wait: number, maxRows: number, pageToken: string | undefined): Promise<{ status: JobStatus; page: ResultPage } | undefined> {
  let page: ResultPage;
  try {
    page = await context.ports.bigquery.results(context.account, ref, { timeoutMs: wait * 1000, maxResults: Math.max(1, Math.min(maxRows, 500)) + 1, ...(pageToken !== undefined ? { pageToken } : {}) }, context.signal);
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "NOT_FOUND") {
      throw new BigQueryError("RESULTS_EXPIRED", "The job's result table is gone", "Run the query again; a result table expires 24 hours after the original run.");
    }
    throw error;
  }
  if (!page.complete) return undefined;
  return { status: await context.ports.bigquery.getJob(context.account, ref, context.signal), page };
}

const jobNext = (job: { readonly project: string; readonly jobId: string; readonly location: string }) =>
  `job({ project: ${plain(job.project)}, jobId: ${plain(job.jobId)}, location: ${plain(job.location)}, wait: 30 })`;

/** A validated identifier for a `next`, in backquotes; anything else is `object`. */
const plain = (value: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? `\`${value}\`` : "`object`");

// ── jobs ─────────────────────────────────────────────────────────────────

export interface JobsInput {
  readonly project?: string;
  readonly state?: "done" | "running" | "pending";
  readonly limit?: number;
  readonly pageToken?: string;
}

export async function jobs(input: JobsInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const settings = settingsOf(context.options, context.account);
  const project = projectOf(settings, input.project);
  const page = await context.ports.bigquery.listJobs(
    {
      account: context.account,
      project,
      ...(input.state !== undefined ? { stateFilter: input.state } : {}),
      maxResults: pageSize(input.limit ?? 50),
      ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
    },
    context.signal,
  );
  return {
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
  };
}

// ── profile ──────────────────────────────────────────────────────────────

export interface ProfileInput {
  readonly project?: string;
  readonly location?: string;
  readonly table?: string;
  readonly sql?: string;
  readonly columns?: readonly string[];
  readonly samplePercent?: number;
  readonly maxBytes?: string | number;
  readonly policyTagged?: "allow";
}

export async function profile(input: ProfileInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const settings = settingsOf(context.options, context.account);
  const project = projectOf(settings, input.project);
  const allowTagged = input.policyTagged === "allow" && context.options.policyTagged === "allow";
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: "profile" });

  let source: string;
  let facts: TableFacts | undefined;
  if (input.table !== undefined) {
    const ref = parseTablePath(input.table, project);
    const info = await context.ports.bigquery.getTable(context.account, ref, context.signal);
    facts = tableFacts(info);
    if (facts.kind !== "data") throw invalid("Only a table or a materialized view is profiled here", "Pass a SELECT to profile instead.");
    source = tableSql(ref);
    if (input.samplePercent !== undefined) {
      if (facts.storage !== "native") throw invalid("TABLESAMPLE needs native BigQuery storage");
      const prober = new RowPolicyProber({ ports: context.ports, account: context.account, project, signal: context.signal }, cacheOf<RowVerdict>(context.ports.clock, "rowpolicy", 10 * 60_000, () => context.ports.clock.now()));
      const verdict = await prober.probe(facts);
      if (verdict.state !== "none") throw invalid("TABLESAMPLE cannot be combined with a row access policy, and the table may have one");
      source = `${source} TABLESAMPLE SYSTEM (${input.samplePercent} PERCENT)`;
    }
  } else {
    if (input.sql === undefined) throw invalid("Pass table or sql", "Name the table, or the SELECT, to profile.");
    source = `(${stripStatement(input.sql)})`;
  }

  const chosen = chooseColumns(input.columns, facts, allowTagged);
  if (chosen.length === 0) throw invalid("No column is left to profile", "Name the columns; a policy-tagged column needs the person's policyTagged option, which the model cannot set.");

  const prepared = await prepareRead(
    rc,
    {
      sql: profileSql(source, chosen, facts !== undefined),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: bytesOf(input.maxBytes) } : {}),
    },
    "read",
  );
  // Over a table, the plugin wrote the SQL itself from the table's schema, so it knows exactly which columns it reads,
  // and `chooseColumns` left every tagged one out. When BigQuery's dry run names that table and nothing else, that is the
  // proof the server-set rule cannot make on its own, and the aggregates come inline.
  const exact = facts !== undefined && prepared.views.length === 0 && prepared.routines.length === 0 && prepared.tables.every((entry) => entry.name === facts!.name);
  const ready: PreparedRead = exact ? { ...prepared, policy: { inline: true } } : prepared;
  if (!allowTagged && !ready.policy.inline) {
    throw new BigQueryError(
      "COLUMN_DENIED",
      ready.policy.why ?? "A profiled column is policy-tagged",
      "Profile the table instead of a SELECT, which leaves its tagged columns out; only the plugin's policyTagged option, which the person sets, can allow a tagged column.",
    );
  }
  const run = await runRead(rc, ready, { maxRows: chosen.length, waitSeconds: 30 });
  await context.bus.emit("changed", { capability: "bigquery.jobs", account: context.account, reason: "read" });
  if (run.state === "running") throw new BigQueryError("JOB_TIMEOUT", "The profile query is still running", "Run the aggregate yourself with query, or try again.");
  if (run.state === "failed") throw new BigQueryError(run.failure!.code, run.failure!.detail, run.failure!.next);

  return {
    columns: (run.rows ?? []).map(profileRow),
    bytesProcessed: run.bytesProcessed,
    bytesBilled: run.bytesBilled,
    costUsd: run.usd,
    cacheHit: run.cacheHit,
    job: run.job,
    ...(run.warnings.length > 0 ? { warnings: [...run.warnings] } : {}),
    trust: "untrusted",
  };
}

function profileRow(row: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = { column: typeof row[0] === "string" ? row[0] : "" };
  const number = (value: unknown) => (typeof value === "number" ? value : undefined);
  const nulls = number(row[1]);
  const distinct = number(row[2]);
  if (nulls !== undefined) out.nulls = nulls;
  if (distinct !== undefined) out.distinctApprox = distinct;
  if (row[3] !== undefined && row[3] !== null) out.min = row[3];
  if (row[4] !== undefined && row[4] !== null) out.max = row[4];
  const quantiles = parseJson(row[5]);
  if (quantiles !== undefined) out.quantiles = quantiles;
  const top = parseJson(row[6]);
  if (top !== undefined) out.top = top;
  return out;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function chooseColumns(requested: readonly string[] | undefined, facts: TableFacts | undefined, allowTagged: boolean): { name: string; type?: string; repeated?: boolean }[] {
  if (facts === undefined) {
    if (requested === undefined || requested.length === 0) throw invalid("Profiling a SELECT needs the columns to profile", "Pass columns, because a SELECT's result schema is not known before it runs.");
    return requested.map((name) => ({ name }));
  }
  if (requested !== undefined) {
    for (const name of requested) {
      const field = facts.columns.find((item) => item.name === name);
      if (!field) throw invalid(`The table has no column named ${column(name, 1)} in its schema`);
      if (!allowTagged && facts.tagged.includes(field.name)) {
        throw new BigQueryError("COLUMN_DENIED", `The column ${column(name, 1)} of the table ${path(facts.project, facts.dataset, facts.table)} is policy-tagged`, "Leave it out; only the plugin's policyTagged option, which the person sets, can allow a tagged column.");
      }
    }
    return requested.map((name) => {
      const field = facts.columns.find((item) => item.name === name);
      return { name, ...(field?.type !== undefined ? { type: field.type } : {}), ...(field?.mode === "REPEATED" ? { repeated: true } : {}) };
    });
  }
  return facts.columns.filter((field) => !isStruct(field) && (allowTagged || !facts.tagged.includes(field.name))).map((field) => ({ name: field.name, type: field.type, ...(field.mode === "REPEATED" ? { repeated: true } : {}) }));
}

/**
 * One query with one `UNION ALL` arm per column: nulls, distinct, min/max, quantiles and the top five values. An arm over
 * a table source reads the table once per arm, and `TABLESAMPLE` draws per arm; the dry run is what bounds the cost.
 */
function profileSql(source: string, columns: readonly { name: string; type?: string; repeated?: boolean }[], typed: boolean): string {
  const arms = columns.map((entry) => {
    const ident = quoteIdent(entry.name);
    const label = quoteLiteral(entry.name);
    const type = entry.type?.toUpperCase();
    const known = typed && type !== undefined;
    const complex = known && (type === "STRUCT" || type === "RECORD" || type === "JSON");
    const repeated = entry.repeated === true || (known && type === "ARRAY");
    const text = (expression: string) => (type === "BYTES" ? `SAFE_CONVERT_BYTES_TO_STRING(${expression})` : `CAST(${expression} AS STRING)`);
    const noneText = "CAST(NULL AS STRING)";
    const nulls = complex ? "CAST(NULL AS INT64)" : `COUNTIF(${ident} IS NULL)`;
    const distinct = complex || repeated ? "CAST(NULL AS INT64)" : `APPROX_COUNT_DISTINCT(${text(ident)})`;
    const orderable = !known || isOrderable(type!);
    const min = complex || repeated || !orderable ? noneText : text(`MIN(${ident})`);
    const max = complex || repeated || !orderable ? noneText : text(`MAX(${ident})`);
    const quantiles = known && NUMERIC_TYPES.has(type!) && !repeated ? `TO_JSON(APPROX_QUANTILES(${ident}, 4))` : noneText;
    const groupable = !known || GROUPABLE.has(type!);
    const top = complex || repeated || !groupable ? noneText : `TO_JSON(APPROX_TOP_COUNT(${ident}, 5))`;
    return `SELECT ${label} AS column_name, ${nulls} AS nulls, ${distinct} AS distinct_approx, ${min} AS min_value, ${max} AS max_value, ${quantiles} AS quantiles, ${top} AS top_values FROM ${source}`;
  });
  return arms.join("\nUNION ALL\n");
}

// ── shared ───────────────────────────────────────────────────────────────

function isoTime(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Date(number).toISOString() : value;
}

function parseTablePath(table: string, fallbackProject: string): TableReference {
  const parts = table.split(".");
  if (parts.length < 2 || parts.some((part) => part.length === 0)) throw invalid("The table path needs project.dataset.table, or dataset.table");
  if (parts.length === 2) return { projectId: fallbackProject, datasetId: parts[0]!, tableId: parts[1]! };
  return { projectId: parts[0]!, datasetId: parts[1]!, tableId: parts.slice(2).join(".") };
}

/** A statement passed as a source: one SELECT, with its trailing semicolon removed and no second statement. */
function stripStatement(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const lexed = createLexer().lex(trimmed);
  if (lexed.ok) {
    const tokens = lexed.tokens.filter((token) => token.kind !== "comment");
    if (tokens.some((token) => token.kind === "punctuation" && token.text === ";")) throw invalid("The source must be one SELECT, without another statement", "Profile a table instead, or reduce the SELECT to one statement.");
  }
  return trimmed;
}
