/**
 * The transport under the BigQuery port (design §8): Google's JSON over `fetch`, one bearer token per request from the
 * auth port, at most eight requests in flight per process, retries with jittered backoff, and Google's failures as the
 * plugin's own errors.
 *
 * Shapes, from Google's REST reference v2:
 * - a successful call answers a JSON resource (the Job, Table and Routine resources);
 * - a failed call answers `{ "error": { "code", "message", "status", "errors": [ ErrorProto ] } }`, where ErrorProto is
 *   `{ reason, location, message, ... }` (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#errorproto and
 *   the API's error-handling section);
 * - a job that ran and failed says so on the resource: `status.errorResult` / `status.errors[]` on the Job
 *   (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobstatus), or `errors[]` on a getQueryResults answer
 *   (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults).
 *
 * Google's `message` is data: it may quote a cell (`ERROR(CONCAT(...))`) or a column name. It goes into `googleError`
 * with `trust: "untrusted"` and never into the error's own text, which is built from codes and validated identifiers
 * only (design §5.6).
 */
import { BigQueryError, type ErrorCode } from "../domain/errors.js"
import { GOOGLE } from "../domain/google.js"
import type { AuthPort } from "../ports.js"

/** Google's largest answer the plugin parses whole; anything bigger is a protocol error, not data (design §8). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/** Requests in flight per process, across every account (design §8). A ninth waits for a slot. */
export const MAX_IN_FLIGHT = 8

/** Retries: three tries, as the design says, for idempotent calls and runs that carry a client job id. */
export interface RetryPolicy {
  readonly tries: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  /** Full jitter: the delay is spread over 0 to the exponential backoff. Off in tests, so they are quick and exact. */
  readonly jitter: boolean
}

export const RETRY: RetryPolicy = { tries: 3, baseDelayMs: 250, maxDelayMs: 8_000, jitter: true }

export interface GoogleErrorInfo {
  readonly reason?: string
  readonly location?: string
  readonly message?: string
}

/** Google's `error` object (or a bare ErrorProto) as the plugin reads it. */
export function googleErrorInfo(body: unknown): GoogleErrorInfo {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
  const first = error && Array.isArray(error.errors) && isRecord(error.errors[0]) ? error.errors[0] : undefined
  const proto = first ?? (isRecord(body) ? body : error)
  return {
    ...(text(proto?.reason) !== undefined ? { reason: text(proto?.reason)! } : {}),
    ...(text(proto?.location) !== undefined ? { location: text(proto?.location)! } : {}),
    ...(text(error?.message ?? proto?.message) !== undefined ? { message: cut(text(error?.message ?? proto?.message)!, 500) } : {}),
  }
}

/** Google's `googleError` for the result envelope, cut as the contract says. */
export function untrustedGoogleError(body: unknown) {
  const info = googleErrorInfo(body)
  return {
    ...(info.reason !== undefined ? { reason: info.reason.slice(0, 64) } : {}),
    ...(info.location !== undefined ? { location: info.location.slice(0, 256) } : {}),
    ...(info.message !== undefined ? { message: info.message } : {}),
    trust: "untrusted" as const,
  }
}

const DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED", "serviceDisabled"])
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "billingTierLimitExceeded"])

/** The codes an HTTP failure becomes. */
export type HttpCode = Extract<ErrorCode, "AUTH_REQUIRED" | "PERMISSION_DENIED" | "API_DISABLED" | "QUOTA_EXCEEDED" | "NOT_FOUND" | "RATE_LIMITED" | "UNAVAILABLE" | "JOB_FAILED">
/** The codes a job Google finished unsuccessfully becomes. */
export type JobCode = Extract<ErrorCode, "BYTES_BILLED_LIMIT" | "JOB_TIMEOUT" | "CANCELLED" | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "PERMISSION_DENIED" | "NOT_FOUND" | "JOB_FAILED">

/**
 * The plugin's code for an HTTP failure, from Google's status and reason. A 401 means the credential Google was given
 * is unusable, which is `AUTH_REQUIRED`: the transport is what sees it, so this is where it is raised (after one fresh
 * token, in `createHttp`). The read path maps this module's `JOB_FAILED` with reason `invalidQuery` to `SQL_INVALID`.
 */
export function codeForStatus(status: number, reason: string | undefined): HttpCode {
  if (status === 401) return "AUTH_REQUIRED"
  if (status === 403) return reason !== undefined && DISABLED_REASONS.has(reason) ? "API_DISABLED" : reason !== undefined && QUOTA_REASONS.has(reason) ? "QUOTA_EXCEEDED" : "PERMISSION_DENIED"
  if (status === 404) return "NOT_FOUND"
  if (status === 429) return "RATE_LIMITED"
  if (status >= 500) return "UNAVAILABLE"
  return "JOB_FAILED"
}

/**
 * The code for a job Google finished unsuccessfully. `bytesBilledLimitExceeded` is `maximumBytesBilled` refusing the
 * job before it ran (design §6.2); `timeout` is the job's own time limit; `stopped` is a cancellation.
 */
export function codeForJobReason(reason: string | undefined): JobCode {
  switch (reason) {
    case "bytesBilledLimitExceeded":
      return "BYTES_BILLED_LIMIT"
    case "timeout":
      return "JOB_TIMEOUT"
    case "stopped":
    case "cancelled":
      return "CANCELLED"
    case "rateLimitExceeded":
    case "jobRateLimitExceeded":
      return "RATE_LIMITED"
    case "quotaExceeded":
    case "dailyLimitExceeded":
      return "QUOTA_EXCEEDED"
    case "accessDenied":
    case "forbidden":
      return "PERMISSION_DENIED"
    case "notFound":
      return "NOT_FOUND"
    default:
      return "JOB_FAILED"
  }
}

/** What an HTTP failure says: only the code's own words and the task's validated identifiers (design §5.6). */
const HTTP_DETAIL: Readonly<Record<HttpCode, (task: string) => string>> = {
  AUTH_REQUIRED: (task) => `Google refused the access token while reading ${task}`,
  PERMISSION_DENIED: (task) => `Google refused to read ${task}`,
  API_DISABLED: (task) => `The BigQuery API is off in the billing project (reading ${task})`,
  QUOTA_EXCEEDED: (task) => `A Google quota stopped the request for ${task}`,
  NOT_FOUND: (task) => `Google could not find ${task}`,
  RATE_LIMITED: (task) => `Google rate-limited the request for ${task} after retries`,
  UNAVAILABLE: (task) => `Google did not answer the request for ${task}`,
  JOB_FAILED: (task) => `Google rejected the request for ${task}`,
}

/** What a failed job says. Google's own message is in `googleError`, never here. */
const JOB_DETAIL: Readonly<Record<JobCode, (job: string) => string>> = {
  BYTES_BILLED_LIMIT: (job) => `The query job ${job} was refused at its byte cap, so nothing was billed`,
  JOB_TIMEOUT: (job) => `The query job ${job} reached its time limit`,
  CANCELLED: (job) => `The query job ${job} was cancelled`,
  RATE_LIMITED: (job) => `Google rate-limited the query job ${job}`,
  QUOTA_EXCEEDED: (job) => `A Google quota stopped the query job ${job}`,
  PERMISSION_DENIED: (job) => `Google refused the query job ${job}`,
  NOT_FOUND: (job) => `Google could not find the query job ${job}`,
  JOB_FAILED: (job) => `The query job ${job} failed`,
}

/** An HTTP failure as the plugin's error: the code and a text from validated identifiers, Google's words in `googleError`. */
export function httpFailure(status: number, body: unknown, retryAfterSec: number | undefined, task: string): BigQueryError {
  const code = codeForStatus(status, googleErrorInfo(body).reason)
  return new BigQueryError(code, HTTP_DETAIL[code](task), undefined, {
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    googleError: untrustedGoogleError(body),
  })
}

/** A job Google finished unsuccessfully, as the plugin's error; its `totalBytesBilled` is the caller's to read. */
export function jobFailure(proto: unknown, job: string): BigQueryError {
  const code = codeForJobReason(googleErrorInfo(proto).reason)
  return new BigQueryError(code, JOB_DETAIL[code](job), undefined, { googleError: untrustedGoogleError(proto) })
}

/** The one stop: a call whose signal is aborted before or during its request (design §8). */
export const cancelled = () => new BigQueryError("CANCELLED", "The call was stopped before Google answered")

export type Method = "GET" | "POST"

export interface Request<T> {
  readonly account: string
  readonly method: Method
  readonly /** A path under GOOGLE.api, each segment already encoded (`/projects/invented-project/jobs`). */ path: string
  readonly query?: Readonly<Record<string, string | number | undefined>>
  readonly body?: unknown
  /** A description built from validated identifiers, for the error text: `the job `oc_…``. */
  readonly task: string
  readonly signal: AbortSignal
  /** GETs are idempotent. A POST is retried only when it carries a client job id (design §8). */
  readonly idempotent: boolean
  readonly expect?: (body: unknown) => T
}

export interface HttpDeps {
  readonly auth: AuthPort
  readonly fetch: typeof globalThis.fetch
  readonly retry?: Partial<RetryPolicy>
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly maxInFlight?: number
}

export interface Http {
  /** Sends one request and returns Google's JSON answer. */
  request<T = unknown>(request: Request<T>): Promise<T>
  /** Formats a path segment: dataset and table ids may hold any character (flexible column names allow Unicode). */
  segment(value: string): string
}

export function createHttp(deps: HttpDeps): Http {
  const retry: RetryPolicy = { ...RETRY, ...deps.retry }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const random = deps.random ?? Math.random
  const gate = limiter(deps.maxInFlight ?? MAX_IN_FLIGHT)

  return {
    segment: (value: string) => encodeURIComponent(value),
    async request<T>(request: Request<T>): Promise<T> {
      if (request.signal.aborted) throw cancelled()
      const url = new URL(`${GOOGLE.api}${request.path}`)
      for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
      const payload = request.body === undefined ? undefined : JSON.stringify(request.body)
      // A 401 gets one fresh token, then a new sign-in; it is not one of the three tries.
      let tokenRetry = false
      let attempt = 1
      for (;;) {
        const token = await deps.auth.token(request.account, request.signal)
        let response: Response
        let json: unknown
        await gate.enter(request.signal)
        try {
          response = await deps.fetch(url, {
            method: request.method,
            headers: {
              authorization: `Bearer ${token.token}`,
              accept: "application/json",
              ...(payload === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(payload === undefined ? {} : { body: payload }),
            signal: request.signal,
            redirect: "error",
          })
          json = (await readAnswer(response, request.task)).json
        } catch (error) {
          if (error instanceof BigQueryError) throw error
          if (request.signal.aborted || isAbort(error)) throw cancelled()
          if (attempt < retry.tries && request.idempotent) {
            await sleep(backoff(attempt, retry, random, undefined))
            attempt += 1
            continue
          }
          throw new BigQueryError("UNAVAILABLE", `The network failed while reading ${request.task}`)
        } finally {
          gate.leave()
        }
        if (response.status === 401 && !tokenRetry) {
          tokenRetry = true
          continue
        }
        const retryAfterSec = retryAfter(response.headers)
        if (isRetryable(response.status) && attempt < retry.tries && request.idempotent) {
          await sleep(backoff(attempt, retry, random, retryAfterSec))
          attempt += 1
          continue
        }
        if (response.status < 200 || response.status >= 300) throw httpFailure(response.status, json, retryAfterSec, request.task)
        return (request.expect ? request.expect(json) : json) as T
      }
    },
  }
}

async function readAnswer(response: Response, task: string): Promise<{ json: unknown }> {
  const length = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw tooLarge(task)
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw tooLarge(task)
  if (text.trim() === "") return { json: undefined }
  try {
    return { json: JSON.parse(text) as unknown }
  } catch {
    // A non-JSON answer is not one of Google's resources: a proxy page, or a truncated body.
    throw new BigQueryError("UNAVAILABLE", `Google's answer for ${task} was not JSON`, undefined, { googleError: { message: cut(text, 500), trust: "untrusted" } })
  }
}

const tooLarge = (task: string) => new BigQueryError("UNAVAILABLE", `Google's answer for ${task} was larger than 10 MiB`)

/** A 429 or a 5xx: Google's own transient failures (design §8). */
const isRetryable = (status: number) => status === 429 || status >= 500

/** Exponential backoff with full jitter, honouring Google's `Retry-After` when it sent one. */
function backoff(attempt: number, policy: RetryPolicy, random: () => number, retryAfterSec: number | undefined): number {
  if (retryAfterSec !== undefined) return Math.min(retryAfterSec * 1000, policy.maxDelayMs)
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
  return policy.jitter ? Math.round(exponential * random()) : exponential
}

/** `Retry-After` in seconds or as an HTTP date; undefined when absent or unreadable. */
export function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")
  if (raw === null || raw.trim() === "") return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined
}

/** At most `limit` holders, in arrival order; a waiter whose call stops leaves without sending (design §8). */
function limiter(limit: number) {
  let active = 0
  const waiting: { readonly signal: AbortSignal; readonly grant: () => void; readonly fail: (error: unknown) => void; readonly onAbort: () => void }[] = []
  const next = () => {
    while (active < limit && waiting.length > 0) {
      const waiter = waiting.shift()!
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      active += 1
      waiter.grant()
    }
  }
  return {
    async enter(signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw cancelled()
      if (active < limit) {
        active += 1
        return
      }
      await new Promise<void>((grant, fail) => {
        const onAbort = () => {
          const index = waiting.indexOf(entry)
          if (index >= 0) waiting.splice(index, 1)
          fail(cancelled())
        }
        const entry = { signal, grant, fail, onAbort }
        waiting.push(entry)
        signal.addEventListener("abort", onAbort, { once: true })
      })
    },
    leave(): void {
      active = Math.max(0, active - 1)
      next()
    },
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

export function cut(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) : value
}

function isAbort(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError"
}
