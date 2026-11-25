/**
 * A faithful fake of the two Google hosts this plugin calls, at the wire: `bigquery.googleapis.com`'s REST v2 paths and
 * `oauth2.googleapis.com`'s token info. Tests drive the plugin's real provider client over it with `fetch`, so what is
 * exercised is the plugin's request building and Google's own JSON shapes, never a second copy of the plugin's types.
 *
 * Every identifier is invented: the project `alpha-analytics`, the dataset `sales`, the tables `orders` and
 * `restricted_orders`. One `restricted_orders` has a row access policy, which is what makes the byte cap unenforceable
 * for a read over it; every other table is a native table with data.
 *
 * The fake answers Google's fields the plugin reads, from the REST reference: `jobReference`, `statistics.query`,
 * `status`, `rows`/`f`/`v`, `totalRows`, `pageToken`, and the reason-first error object. A request it does not know is a
 * 404 with Google's error shape, so a wrong path fails loudly.
 */
import { NOW } from "./time.js";

const HOST = "https://bigquery.googleapis.com/bigquery/v2";
const PROJECT = "alpha-analytics";
const DATASET = "sales";

/** The fields every table's schema has. */
const FIELDS = [
  { name: "order_id", type: "INT64", mode: "NULLABLE" },
  { name: "order_date", type: "DATE", mode: "NULLABLE" },
  { name: "total", type: "NUMERIC", mode: "NULLABLE" },
];

/** Two invented rows, in Google's `f`/`v` form. */
const ROWS = [
  { f: [{ v: "1" }, { v: "2026-11-19" }, { v: "120.50" }] },
  { f: [{ v: "2" }, { v: "2026-11-20" }, { v: "80.25" }] },
];

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

export interface FakeGoogle {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: Recorded[];
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", date: new Date(NOW).toUTCString() } });

/** Google's error object: the reason first, as the transport reads it. */
const failure = (status: number, reason: string, message: string) => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

const queryOf = (body: unknown): string => {
  const value = (body as { configuration?: { query?: { query?: unknown } } } | undefined)?.configuration?.query?.query;
  return typeof value === "string" ? value : "";
};

const dryRunOf = (body: unknown): boolean => (body as { configuration?: { dryRun?: unknown } } | undefined)?.configuration?.dryRun === true;

const tableReference = (tableId: string) => ({ projectId: PROJECT, datasetId: DATASET, tableId });

/** The dry run's `statistics.query` for one statement, as BigQuery answers it. */
function statisticsFor(sql: string): Record<string, unknown> {
  const text = sql.trim().toUpperCase();
  const orders = { referencedTables: [tableReference("orders")], totalBytesProcessed: "1048576", totalBytesProcessedAccuracy: "PRECISE", schema: { fields: FIELDS } };
  if (text.startsWith("CREATE TABLE")) {
    return { statementType: "CREATE_TABLE", totalBytesProcessed: "0", totalBytesProcessedAccuracy: "PRECISE", ddlOperationPerformed: "CREATE", ddlTargetTable: tableReference("orders_copy") };
  }
  if (text.startsWith("DELETE")) {
    return { statementType: "DELETE", ...orders, totalBytesProcessed: "1048576", numDmlAffectedRows: "3" };
  }
  if (text.startsWith("GRANT")) {
    return { statementType: "GRANT_ON_TABLE", totalBytesProcessed: "0", totalBytesProcessedAccuracy: "PRECISE", dclTargetTable: tableReference("orders") };
  }
  if (text.startsWith("EXPORT DATA")) {
    return { statementType: "EXPORT_DATA", ...orders };
  }
  if (text.startsWith("CREATE RESERVATION")) {
    return { statementType: "CREATE_RESERVATION", totalBytesProcessed: "0", totalBytesProcessedAccuracy: "PRECISE" };
  }
  if (text.includes("RESTRICTED_ORDERS")) {
    return { statementType: "SELECT", referencedTables: [tableReference("restricted_orders")], totalBytesProcessed: "1048576", totalBytesProcessedAccuracy: "PRECISE", schema: { fields: FIELDS } };
  }
  return { statementType: "SELECT", ...orders };
}

/** The Job resource a run answers: finished, with what it billed and its rows' schema. */
function jobFor(sql: string, jobId: string): Record<string, unknown> {
  const statistics = statisticsFor(sql);
  return {
    kind: "bigquery#job",
    jobReference: { projectId: PROJECT, jobId, location: "US" },
    configuration: { query: { query: sql }, labels: { oc_plugin: "bigquery-plugin", oc_tool: "write", oc_session: "0000000000000000" } },
    statistics: {
      creationTime: String(NOW - 60_000),
      startTime: String(NOW - 60_000),
      endTime: String(NOW - 30_000),
      query: { ...statistics, totalBytesBilled: "1048576", cacheHit: false, totalSlotMs: "1200" },
    },
    status: { state: "DONE" },
  };
}

/** The jobs this account finished, oldest first by end time; one failed job is here too. */
const JOBS = [
  { jobId: "oc_00000000-0000-4000-8000-000000000001", statementType: "SELECT", created: NOW - 3_600_000, ended: NOW - 3_500_000, billed: "1048576" },
  { jobId: "oc_00000000-0000-4000-8000-000000000002", statementType: "CREATE_TABLE", created: NOW - 1_800_000, ended: NOW - 1_700_000, billed: "0" },
];

/** A job resource for a list item or a get: `state` is DONE, the statistics carry the times. */
function listedJob(job: (typeof JOBS)[number]): Record<string, unknown> {
  return {
    jobReference: { projectId: PROJECT, jobId: job.jobId, location: "US" },
    state: "DONE",
    configuration: { query: { query: `SELECT * FROM \`${PROJECT}.${DATASET}.orders\`` }, labels: { oc_plugin: "bigquery-plugin", oc_tool: job.statementType === "SELECT" ? "query" : "write", oc_session: "0000000000000000" } },
    statistics: {
      creationTime: String(job.created),
      endTime: String(job.ended),
      query: { statementType: job.statementType, totalBytesProcessed: job.billed, totalBytesBilled: job.billed, cacheHit: false },
    },
    status: { state: "DONE" },
  };
}

/** The answer to one request, or Google's 404. */
function answer(request: Recorded): Response {
  const url = new URL(request.url);
  const path = url.pathname.replace("/bigquery/v2", "");
  const method = request.method;

  if (path === "/tokeninfo") return json({ email: "ana@example.test", email_verified: "true" });
  if (method === "GET" && path === "/projects") return json({ projects: [{ projectReference: { projectId: PROJECT }, friendlyName: "Alpha Analytics" }], totalItems: 1 });
  if (method === "GET" && path === `/projects/${PROJECT}/datasets`) return json({ datasets: [{ datasetReference: { projectId: PROJECT, datasetId: DATASET }, location: "US" }], totalItems: 1 });
  if (method === "GET" && path === `/projects/${PROJECT}/datasets/${DATASET}/tables`) {
    const listItem = (tableId: string) => ({ kind: "bigquery#table", tableReference: tableReference(tableId), type: "TABLE", location: "US" });
    return json({ tables: [listItem("orders"), listItem("restricted_orders")], totalItems: 2 });
  }
  const table = /^\/projects\/[^/]+\/datasets\/[^/]+\/tables\/([^/]+)$/.exec(path);
  if (method === "GET" && table !== null) {
    const tableId = decodeURIComponent(table[1]!);
    return json({ kind: "bigquery#table", tableReference: tableReference(tableId), type: "TABLE", location: "US", numBytes: "4096", numRows: "2", lastModifiedTime: String(NOW - 90_000), schema: { fields: FIELDS } });
  }
  const data = /^\/projects\/[^/]+\/datasets\/[^/]+\/tables\/([^/]+)\/data$/.exec(path);
  if (method === "GET" && data !== null) return json({ totalRows: String(ROWS.length), rows: ROWS });
  const policies = /^\/projects\/[^/]+\/datasets\/[^/]+\/tables\/([^/]+)\/rowAccessPolicies$/.exec(path);
  if (method === "GET" && policies !== null) {
    const tableId = decodeURIComponent(policies[1]!);
    return tableId === "restricted_orders" ? json({ rowAccessPolicies: [{ rowAccessPolicyReference: { projectId: PROJECT, datasetId: DATASET, tableId, policyId: "policy_1" } }] }) : json({});
  }
  if (method === "POST" && path === `/projects/${PROJECT}/queries`) {
    return json({ kind: "bigquery#queryResponse", jobReference: { projectId: PROJECT, jobId: "job_estimate", location: "US" }, statementType: "SELECT", totalBytesProcessed: "1048576", jobComplete: true });
  }
  if (method === "POST" && path === `/projects/${PROJECT}/jobs`) {
    const sql = queryOf(request.body);
    // A dataset's INFORMATION_SCHEMA view is refused for this account, which makes `search` fall back to table names.
    if (/INFORMATION_SCHEMA/i.test(sql)) return failure(403, "accessDenied", "Access Denied: Table alpha-analytics:sales.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS");
    if (dryRunOf(request.body)) return json({ kind: "bigquery#job", jobReference: { projectId: PROJECT, jobId: "job_dry", location: "US" }, statistics: { query: statisticsFor(sql) } });
    const jobId = (request.body as { jobReference?: { jobId?: string } } | undefined)?.jobReference?.jobId ?? "job_run";
    return json(jobFor(sql, jobId));
  }
  if (method === "GET" && path === `/projects/${PROJECT}/jobs`) {
    const state = url.searchParams.get("stateFilter");
    if (state !== null && state !== "DONE") return json({ jobs: [] });
    const min = Number(url.searchParams.get("minCreationTime") ?? Number.NEGATIVE_INFINITY);
    const max = Number(url.searchParams.get("maxCreationTime") ?? Number.POSITIVE_INFINITY);
    const jobs = JOBS.filter((job) => job.created >= min && job.created <= max).map((job) => listedJob(job));
    return json({ kind: "bigquery#jobList", jobs, totalItems: jobs.length });
  }
  const cancel = /^\/projects\/[^/]+\/jobs\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && cancel !== null) {
    const job = jobFor("SELECT 1", decodeURIComponent(cancel[1]!));
    return json({ kind: "bigquery#jobCancelResponse", job: { ...job, status: { state: "DONE" } } });
  }
  const getJob = /^\/projects\/[^/]+\/jobs\/([^/]+)$/.exec(path);
  if (method === "GET" && getJob !== null) {
    const jobId = decodeURIComponent(getJob[1]!);
    const known = JOBS.find((job) => job.jobId === jobId);
    return known === undefined ? failure(404, "notFound", "Job not found") : json(listedJob(known));
  }
  const results = /^\/projects\/[^/]+\/queries\/([^/]+)$/.exec(path);
  if (method === "GET" && results !== null) {
    return json({ kind: "bigquery#getQueryResultsResponse", jobReference: { projectId: PROJECT, jobId: decodeURIComponent(results[1]!), location: "US" }, jobComplete: true, schema: { fields: FIELDS }, totalRows: String(ROWS.length), rows: ROWS });
  }
  return failure(404, "notFound", `The fake has no answer for ${method} ${path}`);
}

/** A fetch that answers Google's hosts from the fixtures above and records every request. */
export function fakeGoogle(): FakeGoogle {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request = { method: (init?.method ?? "GET").toUpperCase(), url, ...(body === undefined ? {} : { body }) };
    requests.push(request);
    return answer(request);
  };
  return { fetch: fetchImpl as typeof globalThis.fetch, requests };
}

export { DATASET, FIELDS, HOST, JOBS, PROJECT, ROWS, tableReference };
