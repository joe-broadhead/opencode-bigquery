/**
 * A loopback fake of Google's two hosts for BigQuery (the interface is `test/fake/server.ts`): it serves
 * bigquery.googleapis.com's REST v2 paths and oauth2.googleapis.com's token endpoint over plain HTTP on 127.0.0.1, so
 * the host tests' fetch router (`test/host/route-fetch.ts`) can send Google's hosts here. Nothing leaves the machine.
 *
 * A test scripts answers per route: `enqueue` queues them in order, `answer` sets a route's default, and every request
 * is recorded (the `authorization` and `dpop` headers by name only, never by value). Latency, a 429 and a mid-page
 * failure are just answers with a `delayMs` or a failure body.
 *
 * The shapes replay `test/fixtures/google/*.json`: invented from the REST reference on 17 Nov 2026, every identifier
 * invented, and `scripts/capture-fixtures/index.mjs` replaces them with sanitised recordings at the live check.
 */
import { readdirSync, readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import type { FakeAnswer, FakeGoogleServer, RecordedRequest, Route } from "./server.js"

/** A fixture: the request a recording was made with, and Google's answer. */
export interface Fixture {
  readonly name: string
  readonly request: { readonly method: string; readonly path: string; readonly dryRun?: boolean }
  readonly response: FakeAnswer
}

export interface BigQueryFake extends FakeGoogleServer {
  /** Requests being answered right now; the transport's cap of eight is measured with it (design §8). */
  readonly inFlight: number
  readonly maxInFlight: number
  /** How many answers the fake gave, including built-in ones. */
  readonly answered: number
}

/** Starts the fake on an ephemeral loopback port. */
export async function startFake(): Promise<BigQueryFake> {
  const entries: { route: Route; queue: FakeAnswer[]; fallback?: FakeAnswer | ((request: RecordedRequest) => FakeAnswer); match: (request: RecordedRequest) => boolean }[] = []
  const routes = new Map<string, (typeof entries)[number]>()
  const requests: RecordedRequest[] = []
  let scopes: readonly string[] = []
  let token = 0
  let inFlight = 0
  let maxInFlight = 0
  let answered = 0

  const server = createServer((request, response) => {
    void handle(request, response)
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const fake: BigQueryFake = {
    origin,
    requests,
    get inFlight() {
      return inFlight
    },
    get maxInFlight() {
      return maxInFlight
    },
    get answered() {
      return answered
    },
    enqueue(route, ...answers) {
      const entry = entryFor(route)
      entry.queue.push(...answers)
    },
    answer(route, answer) {
      entryFor(route).fallback = answer
    },
    refreshScopes(next) {
      scopes = [...next]
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
  return fake

  function entryFor(route: Route) {
    const key = `${route.method.toUpperCase()} ${route.path instanceof RegExp ? route.path.source : route.path} ${route.dryRun ?? ""}`
    const found = routes.get(key)
    if (found) return found
    const entry = { route, queue: [] as FakeAnswer[], fallback: undefined as FakeAnswer | ((request: RecordedRequest) => FakeAnswer) | undefined, match: (request: RecordedRequest) => matches(route, request) }
    routes.set(key, entry)
    entries.push(entry)
    return entry
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      const url = new URL(request.url ?? "/", origin)
      const body = await readBody(request)
      const recorded: RecordedRequest = {
        method: request.method ?? "GET",
        host: hostOf(url.pathname),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: headersOf(request),
        ...(body === undefined ? {} : { body }),
        at: Date.now(),
      }
      requests.push(recorded)
      const violation = contractViolation(recorded)
      const answer = violation === undefined ? next(recorded) : refused(recorded, violation)
      if (answer.delayMs !== undefined) await sleep(answer.delayMs)
      answered += 1
      await respond(response, answer)
    } catch (error) {
      answered += 1
      respond(response, { status: 500, body: { error: { code: 500, message: String(error), errors: [{ reason: "fakeFailure", message: String(error) }] } } })
    } finally {
      inFlight -= 1
    }
  }

  /** The next answer for a request: its route's queue, then its default, then the token and revoke endpoints. */
  function next(request: RecordedRequest): FakeAnswer {
    for (const entry of entries) {
      if (!entry.match(request)) continue
      const queued = entry.queue.shift()
      if (queued) return queued
      if (entry.fallback !== undefined) return typeof entry.fallback === "function" ? entry.fallback(request) : entry.fallback
      return unrouted(request, "the route has no answer queued and no default")
    }
    if (request.method === "POST" && request.path === "/token") {
      token += 1
      return {
        status: 200,
        headers: { "cache-control": "no-store" },
        body: { access_token: `invented-access-token-${token}`, expires_in: 3599, scope: scopes.join(" "), token_type: "Bearer" },
      }
    }
    // Google's revocation endpoint. The plugin must never call it (design §3.1); `revokeRequests` fails a test that did.
    if (request.path === "/revoke") return { status: 200, body: {} }
    return unrouted(request, "no route matches it")
  }

  /** The fake's own rejection: Google would not accept this request either, and a test must see it. */
  function refused(request: RecordedRequest, why: string): FakeAnswer {
    return {
      status: 400,
      body: {
        error: {
          code: 400,
          message: `the fake refuses ${request.method} ${request.path}: ${why}`,
          errors: [{ reason: "invalid", message: why, domain: "global" }],
          status: "INVALID_ARGUMENT",
        },
      },
    }
  }

  function unrouted(request: RecordedRequest, why: string): FakeAnswer {
    return {
      status: 501,
      body: {
        error: {
          code: 501,
          message: `the fake has no answer for ${request.method} ${request.path}: ${why}`,
          errors: [{ reason: "fakeUnrouted", message: `no answer for ${request.method} ${request.path}` }],
        },
      },
    }
  }
}

/** Whether a request matches a route: method, path (`:name` for one segment, or a RegExp) and, for jobs.insert, dryRun. */
export function matches(route: Route, request: { readonly method: string; readonly path: string; readonly body?: unknown }): boolean {
  if (route.method.toUpperCase() !== request.method.toUpperCase()) return false
  if (!pathMatches(route.path, request.path)) return false
  if (route.dryRun === undefined) return true
  return dryRunOf(request.body) === route.dryRun
}

/** The dry-run flag of a jobs.insert body or a jobs.query body. */
export function dryRunOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false
  const record = body as { readonly configuration?: { readonly dryRun?: unknown }; readonly dryRun?: unknown }
  return record.configuration?.dryRun === true || record.dryRun === true
}

function pathMatches(pattern: string | RegExp, path: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(path)
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("/")
  return new RegExp(`^${source}$`).test(path)
}

function hostOf(path: string): string {
  return path.startsWith("/token") || path.startsWith("/revoke") ? "oauth2.googleapis.com" : "bigquery.googleapis.com"
}

const SENSITIVE = new Set(["authorization", "dpop", "cookie", "proxy-authorization", "set-cookie"])

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers[name] = SENSITIVE.has(name.toLowerCase()) ? "sent" : Array.isArray(value) ? value.join(",") : value
  }
  return headers
}

const MAX_BODY = 2 * 1024 * 1024

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY) throw new Error("the fake refuses a request body over 2 MiB")
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  const text = Buffer.concat(chunks).toString("utf8")
  const type = request.headers["content-type"] ?? ""
  if (!String(type).includes("json") && !/^\s*[{[]/.test(text)) return text
  return JSON.parse(text) as unknown
}

/** A body that never settles: the fake holds the request in flight (no headers) until the test stops it or closes the fake. */
export function pending(): unknown {
  return new Promise(() => undefined)
}

function respond(response: ServerResponse, answer: FakeAnswer): Promise<void> | void {
  if (response.writableEnded || response.destroyed) return
  // An answer's body may be a promise: nothing is written until it settles, which is how a test holds a call in flight.
  if (answer.body instanceof Promise) {
    return answer.body.then((body) => write(response, answer, body))
  }
  return write(response, answer, answer.body)
}

function write(response: ServerResponse, answer: FakeAnswer, value: unknown): void {
  if (response.writableEnded || response.destroyed) return
  const body = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)
  response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers })
  response.end(body)
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXTURES = new URL("../fixtures/google/", import.meta.url)

/** Every invented fixture, by name, in the order the files sort. */
export function loadFixtures(): Fixture[] {
  const dir = fileURLToPath(FIXTURES)
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ ...(JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as Omit<Fixture, "name">), name: name.replace(/\.json$/, "") }))
}

/** Queues a fixture's answer on its own request's route, as the recording was made. */
export function replay(fake: FakeGoogleServer, fixture: Fixture): void {
  const { method, path } = fixture.request
  fake.enqueue({ method, path, ...(fixture.request.dryRun !== undefined ? { dryRun: fixture.request.dryRun } : {}) }, fixture.response)
}

// ── Invented shapes ──────────────────────────────────────────────────────

/** Google's standard error body, with an ErrorProto (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#errorproto). */
export function googleError(status: number, reason: string, message: string, location?: string): FakeAnswer {
  return {
    status,
    body: { error: { code: status, message, errors: [{ reason, message, ...(location !== undefined ? { location } : {}), domain: "global" }], status: reason } },
  }
}

/** A Job resource (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job) with the fields a test sets. */
export function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "bigquery#job",
    jobReference: { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000001", location: "EU" },
    configuration: { jobType: "QUERY", query: { query: "SELECT 1", useLegacySql: false }, jobTimeoutMs: "600000", labels: { oc_plugin: "bigquery" } },
    statistics: { creationTime: "1763377200000", startTime: "1763377200500", endTime: "1763377202000" },
    status: { state: "RUNNING" },
    ...overrides,
  }
}

/** `statistics.query` of a finished job (JobStatistics2). */
export function queryStatistics(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    statementType: "SELECT",
    totalBytesProcessed: "123456789",
    totalBytesBilled: "10485760",
    totalSlotMs: "42",
    cacheHit: false,
    referencedTables: [{ projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }],
    ...overrides,
  }
}

/** A `getQueryResults` answer (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults). */
export function results(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "bigquery#getQueryResultsResponse",
    jobReference: { projectId: "invented-project", jobId: "oc_00000000-0000-4000-8000-000000000001", location: "EU" },
    jobComplete: true,
    totalRows: "0",
    ...overrides,
  }
}

/** One row in Google's `f`/`v` form, from plain values. */
export function row(...values: readonly unknown[]): { f: { v: unknown }[] } {
  return { f: values.map((value) => ({ v: value === undefined ? null : value })) }
}

// ── The request contract ─────────────────────────────────────────────────

/**
 * What Google's REST v2 accepts, as far as this plugin may send it, so the fake rejects a request the real API would
 * not: an unknown query parameter, an empty `location`, a body field that is not on the resource, a JSON body where the
 * page says the body must be empty, or an enum value in the wrong case. Each operation cites the page it comes from.
 * The limits: it checks names and enum spellings, not every nested field's type, and only the paths this plugin uses.
 */
export function contractViolation(request: { readonly method: string; readonly path: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown }): string | undefined {
  const candidates = OPERATIONS.filter((entry) => entry.path.test(request.path))
  const method = request.method.toUpperCase()
  // Both jobs.insert and jobs.list answer `/jobs`; prefer the operation whose method this request claims.
  const operation = candidates.find((entry) => entry.method === method) ?? candidates[0]
  if (operation === undefined) return undefined
  if (operation.method !== request.method.toUpperCase()) return `Google's ${operation.name} is ${operation.method}, not ${request.method}`
  for (const name of Object.keys(request.query ?? {})) {
    if (!operation.params.includes(name)) return `${name} is not a parameter of ${operation.name}`
    if (name === "location" && request.query?.[name] === "") return "Google refuses an empty location"
  }
  for (const [name, allowed] of Object.entries(operation.enums ?? {})) {
    const value = request.query?.[name]
    if (value !== undefined && !allowed.includes(value)) return `${name}=${value} is not one of ${allowed.join(", ")} for ${operation.name}`
  }
  const complaint = bodyViolation(operation.body, request.body)
  return complaint === undefined ? undefined : `${operation.name}: ${complaint}`
}

interface Operation {
  readonly name: string
  readonly method: "GET" | "POST"
  readonly path: RegExp
  readonly params: readonly string[]
  readonly body?: "job" | "query" | "permissions" | "empty" | "none"
  readonly enums?: Readonly<Record<string, readonly string[]>>
}

const V2 = "^/bigquery/v2"
const OPERATIONS: readonly Operation[] = [
  { name: "projects.list", method: "GET", path: new RegExp(`${V2}/projects$`), params: ["maxResults", "pageToken"] },
  { name: "datasets.list", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/datasets$`), params: ["all", "filter", "maxResults", "pageToken"] },
  { name: "tables.list", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/datasets/[^/]+/tables$`), params: ["maxResults", "pageToken"] },
  { name: "tables.get", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/datasets/[^/]+/tables/[^/:]+$`), params: ["selectedFields", "view"] },
  { name: "tabledata.list", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/datasets/[^/]+/tables/[^/]+/data$`), params: ["maxResults", "pageToken", "selectedFields", "startIndex", "formatOptions.useInt64Timestamp"] },
  { name: "tables.testIamPermissions", method: "POST", path: new RegExp(`${V2}/projects/[^/]+/datasets/[^/]+/tables/[^/:]+:testIamPermissions$`), params: [], body: "permissions" },
  { name: "rowAccessPolicies.list", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/datasets/[^/]+/tables/[^/]+/rowAccessPolicies$`), params: ["pageSize", "pageToken"] },
  { name: "routines.list", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/datasets/[^/]+/routines$`), params: ["maxResults", "pageToken", "readMask", "filter"] },
  { name: "routines.get", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/datasets/[^/]+/routines/[^/]+$`), params: ["readMask"] },
  { name: "jobs.insert", method: "POST", path: new RegExp(`${V2}/projects/[^/]+/jobs$`), params: [], body: "job" },
  {
    name: "jobs.list",
    method: "GET",
    path: new RegExp(`${V2}/projects/[^/]+/jobs$`),
    params: ["allUsers", "maxResults", "minCreationTime", "maxCreationTime", "pageToken", "projection", "stateFilter", "parentJobId", "fields"],
    enums: { projection: ["MINIMAL", "FULL"], stateFilter: ["DONE", "PENDING", "RUNNING"] },
  },
  { name: "jobs.get", method: "GET", path: new RegExp(`${V2}/projects/[^/]+/jobs/[^/]+$`), params: ["location", "fields"] },
  { name: "jobs.cancel", method: "POST", path: new RegExp(`${V2}/projects/[^/]+/jobs/[^/]+/cancel$`), params: ["location"], body: "empty" },
  {
    name: "jobs.getQueryResults",
    method: "GET",
    path: new RegExp(`${V2}/projects/[^/]+/queries/[^/]+$`),
    params: ["startIndex", "pageToken", "maxResults", "timeoutMs", "location", "formatOptions.useInt64Timestamp", "fields"],
  },
  { name: "jobs.query", method: "POST", path: new RegExp(`${V2}/projects/[^/]+/queries$`), params: [], body: "query" },
]

const JOB = new Set(["kind", "etag", "id", "selfLink", "user_email", "configuration", "jobReference", "statistics", "status", "principal_subject", "jobCreationReason"])
const JOB_REFERENCE = new Set(["projectId", "jobId", "location"])
const JOB_CONFIGURATION = new Set(["jobType", "query", "load", "copy", "extract", "dryRun", "jobTimeoutMs", "labels", "reservation"])
const JOB_QUERY = new Set([
  "query", "destinationTable", "tableDefinitions", "userDefinedFunctionResources", "createDisposition", "writeDisposition",
  "defaultDataset", "priority", "preserveNulls", "allowLargeResults", "useQueryCache", "flattenResults", "maximumBillingTier",
  "maximumBytesBilled", "useLegacySql", "parameterMode", "queryParameters", "schemaUpdateOptions", "timePartitioning",
  "rangePartitioning", "clustering", "destinationEncryptionConfiguration", "scriptOptions", "connectionProperties",
  "createSession", "secureContext", "systemVariables",
])
const QUERY_REQUEST = new Set([
  "kind", "query", "maxResults", "defaultDataset", "timeoutMs", "destinationEncryptionConfiguration", "dryRun", "preserveNulls",
  "useQueryCache", "useLegacySql", "parameterMode", "queryParameters", "location", "formatOptions", "connectionProperties",
  "labels", "maximumBytesBilled", "requestId", "createSession", "jobCreationMode", "queryResultsFormat", "secureContext",
  "jobTimeoutMs", "reservation", "arrowSerializationOptions",
])
const FORMAT_OPTIONS = new Set(["useInt64Timestamp"])

function bodyViolation(kind: Operation["body"], body: unknown): string | undefined {
  if (kind === undefined || kind === "none") return undefined
  if (kind === "empty") return body === undefined ? undefined : "Google's request body must be empty"
  if (!isObject(body)) return "a JSON body is required"
  if (kind === "permissions") return unknownKeys(body, new Set(["permissions"]), "TestIamPermissionsRequest")
  if (kind === "query") {
    const problem = unknownKeys(body, QUERY_REQUEST, "QueryRequest")
    if (problem !== undefined) return problem
    if (body.formatOptions !== undefined) return unknownKeys(body.formatOptions, FORMAT_OPTIONS, "DataFormatOptions")
    return undefined
  }
  const top = unknownKeys(body, JOB, "Job")
  if (top !== undefined) return top
  const reference = body.jobReference
  if (reference !== undefined) {
    const problem = unknownKeys(reference, JOB_REFERENCE, "JobReference")
    if (problem !== undefined) return problem
    const location = isObject(reference) ? reference.location : undefined
    if (typeof location === "string" && location === "") return "Google refuses an empty JobReference.location"
  }
  const configuration = body.configuration
  if (configuration === undefined) return undefined
  const field = unknownKeys(configuration, JOB_CONFIGURATION, "JobConfiguration")
  if (field !== undefined) return field
  const query = isObject(configuration) ? configuration.query : undefined
  return query === undefined ? undefined : unknownKeys(query, JOB_QUERY, "JobConfigurationQuery")
}

function unknownKeys(value: unknown, allowed: ReadonlySet<string>, resource: string): string | undefined {
  if (!isObject(value)) return `${resource} must be an object`
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  return unknown.length > 0 ? `${resource} has no field ${unknown.map((key) => `"${key}"`).join(", ")}` : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
