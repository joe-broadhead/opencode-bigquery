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
 * - a failed job is an HTTP 4xx on `jobs.getQueryResults` (or `status.errorResult` on the Job), with the reason
 *   `bytesBilledLimitExceeded`, `timeout`, `jobRateLimitExceeded`, `jobBackendError` and so on
 *   (https://cloud.google.com/bigquery/docs/error-messages); the code comes from the *reason*, not the status;
 * - `rateLimitExceeded` is HTTP 403 **or** 429, and is retried either way (same page, and design §8).
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

/** How long an ordinary call waits for Google before the connection counts as stalled and is retried. */
export const DEADLINE_MS = 60_000

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

/** The codes a failed Google call or job becomes. */
export type FailureCode = Extract<
  ErrorCode,
  | "AUTH_REQUIRED"
  | "API_DISABLED"
  | "PERMISSION_DENIED"
  | "QUOTA_EXCEEDED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "JOB_FAILED"
  | "BYTES_BILLED_LIMIT"
  | "JOB_TIMEOUT"
  | "CANCELLED"
>

/**
 * Google's reasons, which decide the code before the status does (https://cloud.google.com/bigquery/docs/error-messages).
 * `responseTooLarge` and `billingNotEnabled` are 403s that are not permission problems; they stay `JOB_FAILED`, with
 * Google's own words in `googleError`.
 */
const REASON_CODES: Readonly<Record<string, FailureCode>> = {
  rateLimitExceeded: "RATE_LIMITED",
  jobRateLimitExceeded: "RATE_LIMITED",
  quotaExceeded: "QUOTA_EXCEEDED",
  dailyLimitExceeded: "QUOTA_EXCEEDED",
  billingTierLimitExceeded: "QUOTA_EXCEEDED",
  accessNotConfigured: "API_DISABLED",
  serviceDisabled: "API_DISABLED",
  accessDenied: "PERMISSION_DENIED",
  forbidden: "PERMISSION_DENIED",
  insufficientPermissions: "PERMISSION_DENIED",
  notFound: "NOT_FOUND",
  bytesBilledLimitExceeded: "BYTES_BILLED_LIMIT",
  timeout: "JOB_TIMEOUT",
  stopped: "CANCELLED",
  cancelled: "CANCELLED",
}

/** The plugin's code for an HTTP failure: Google's reason first, then the status. */
export function failureCode(status: number, reason: string | undefined): FailureCode {
  if (reason !== undefined && Object.hasOwn(REASON_CODES, reason)) return REASON_CODES[reason]!
  if (status === 401) return "AUTH_REQUIRED"
  if (status === 403) return "PERMISSION_DENIED"
  if (status === 404) return "NOT_FOUND"
  if (status === 429) return "RATE_LIMITED"
  if (status >= 500) return "UNAVAILABLE"
  return "JOB_FAILED"
}

/** Reasons Google answers with a 403 that are still a rate limit, and the 5xx reasons, are retried (design §8). */
export function isRetryable(status: number, reason: string | undefined): boolean {
  return status === 429 || status >= 500 || reason === "rateLimitExceeded" || reason === "backendError" || reason === "internalError"
}

/** What an HTTP failure says: only the code's own words and the task's validated identifiers (design §5.6). */
const FAILURE_DETAIL: Readonly<Record<FailureCode, (task: string) => string>> = {
  AUTH_REQUIRED: (task) => `Google refused the access token while reading ${task}`,
  BYTES_BILLED_LIMIT: (task) => `Google stopped the request for ${task} at its byte cap, so nothing was billed`,
  JOB_TIMEOUT: (task) => `Google stopped the request for ${task} at its time limit`,
  CANCELLED: (task) => `The request for ${task} was cancelled`,
  RATE_LIMITED: (task) => `Google rate-limited the request for ${task} after retries`,
  QUOTA_EXCEEDED: (task) => `A Google quota stopped the request for ${task}`,
  PERMISSION_DENIED: (task) => `Google refused to read ${task}`,
  API_DISABLED: (task) => `The BigQuery API is off in the billing project (reading ${task})`,
  NOT_FOUND: (task) => `Google could not find ${task}`,
  UNAVAILABLE: (task) => `Google did not answer the request for ${task}`,
  JOB_FAILED: (task) => `Google rejected the request for ${task}`,
}

/** What a failed job says. Google's own message is in `googleError`, never here. */
const JOB_DETAIL: Readonly<Record<FailureCode, (job: string) => string>> = {
  BYTES_BILLED_LIMIT: (job) => `The query job ${job} was refused at its byte cap, so nothing was billed`,
  JOB_TIMEOUT: (job) => `The query job ${job} reached its time limit`,
  CANCELLED: (job) => `The query job ${job} was cancelled`,
  RATE_LIMITED: (job) => `Google rate-limited the query job ${job}`,
  QUOTA_EXCEEDED: (job) => `A Google quota stopped the query job ${job}`,
  PERMISSION_DENIED: (job) => `Google refused the query job ${job}`,
  NOT_FOUND: (job) => `Google could not find the query job ${job}`,
  AUTH_REQUIRED: (job) => `Google refused the access token for the query job ${job}`,
  API_DISABLED: (job) => `The BigQuery API is off in the billing project (query job ${job})`,
  UNAVAILABLE: (job) => `Google did not answer the query job ${job}`,
  JOB_FAILED: (job) => `The query job ${job} failed`,
}

/** An HTTP failure as the plugin's error: the code and a text from validated identifiers, Google's words in `googleError`. */
export function httpFailure(status: number, body: unknown, retryAfterSec: number | undefined, task: string): BigQueryError {
  const code = failureCode(status, googleErrorInfo(body).reason)
  return new BigQueryError(code, FAILURE_DETAIL[code](task), undefined, {
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    googleError: untrustedGoogleError(body),
  })
}

/** A job failure's code: Google's reason, and `JOB_FAILED` for a reason this version does not know. */
export function jobFailureCode(reason: string | undefined): FailureCode {
  return reason !== undefined && Object.hasOwn(REASON_CODES, reason) ? REASON_CODES[reason]! : "JOB_FAILED"
}

/** A job Google finished unsuccessfully, as the plugin's error; its `totalBytesBilled` is the caller's to read. */
export function jobFailure(proto: unknown, job: string): BigQueryError {
  const code = jobFailureCode(googleErrorInfo(proto).reason)
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
  /** A stop's `jobs.cancel` must not queue behind eight long-polls: it skips the in-flight cap. */
  readonly priority?: boolean
  /** How long one attempt may take before it counts as a stalled connection; `DEADLINE_MS` by default. */
  readonly deadlineMs?: number
  readonly expect?: (body: unknown) => T
}

export interface HttpDeps {
  readonly auth: AuthPort
  readonly fetch: typeof globalThis.fetch
  readonly retry?: Partial<RetryPolicy>
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly maxInFlight?: number
}

export interface Http {
  /** Sends one request and returns Google's JSON answer. */
  request<T = unknown>(request: Request<T>): Promise<T>
  /** Formats a path segment: dataset and table ids may hold any character (flexible names allow Unicode). */
  segment(value: string): string
}

export function createHttp(deps: HttpDeps): Http {
  const retry: RetryPolicy = { ...RETRY, ...deps.retry }
  const sleep = deps.sleep ?? delay
  const random = deps.random ?? Math.random
  const gate = limiter(deps.maxInFlight ?? MAX_IN_FLIGHT)

  return {
    segment: (value: string) => {
      // `encodeURIComponent("..")` leaves it as `..`, which WHATWG URL then resolves, leaving the collection.
      if (value === "." || value === ".." || value === "") {
        throw new BigQueryError("INPUT_INVALID", "A path segment cannot be \".\", \"..\" or empty", "This is a plugin bug: report it with the call that made it.")
      }
      return encodeURIComponent(value)
    },
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
        const deadline = withDeadline(request.signal, request.deadlineMs ?? DEADLINE_MS)
        let response: Response | undefined
        let json: unknown
        if (!request.priority) await gate.enter(request.signal)
        try {
          response = await deps.fetch(url, {
            method: request.method,
            headers: {
              authorization: `Bearer ${token.token}`,
              accept: "application/json",
              ...(payload === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(payload === undefined ? {} : { body: payload }),
            signal: deadline.signal,
            redirect: "error",
          })
          // A 401 is not Google's answer to the call: never parse it, and give it one fresh token.
          if (response.status === 401 && !tokenRetry) {
            tokenRetry = true
            await discard(response)
            continue
          }
          // A 429 or a 5xx is retried before the body is read, so a proxy's HTML page cannot stop the retry (L-1).
          if ((response.status === 429 || response.status >= 500) && attempt < retry.tries && request.idempotent) {
            const retryAfterSec = retryAfter(response.headers)
            await discard(response)
            await sleep(backoff(attempt, retry, random, retryAfterSec), request.signal)
            attempt += 1
            continue
          }
          json = (await readAnswer(response, request.task)).json
        } catch (error) {
          if (error instanceof BigQueryError) throw error
          if (request.signal.aborted || (isAbort(error) && !deadline.expired())) throw cancelled()
          if (attempt < retry.tries && request.idempotent) {
            await sleep(backoff(attempt, retry, random, undefined), request.signal)
            attempt += 1
            continue
          }
          throw new BigQueryError("UNAVAILABLE", `Google did not answer the request for ${request.task}`)
        } finally {
          deadline.done()
          if (!request.priority) gate.leave()
        }
        const retryAfterSec = retryAfter(response.headers)
        // A 403 `rateLimitExceeded` is a rate limit too, and is retried with the same backoff.
        const reason = googleErrorInfo(json).reason
        if (response.status >= 400 && isRetryable(response.status, reason) && attempt < retry.tries && request.idempotent) {
          await sleep(backoff(attempt, retry, random, retryAfterSec), request.signal)
          attempt += 1
          continue
        }
        if (response.status < 200 || response.status >= 300) throw httpFailure(response.status, json, retryAfterSec, request.task)
        return (request.expect ? request.expect(json) : json) as T
      }
    },
  }
}

/** Reads an answer up to 10 MiB, counting as it goes: a large or chunked body is never buffered whole (L-9). */
async function readAnswer(response: Response, task: string): Promise<{ json: unknown }> {
  const length = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await discard(response)
    throw tooLarge(task)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return { json: undefined }
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw tooLarge(task)
    }
    chunks.push(Buffer.from(value))
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.trim() === "") return { json: undefined }
  try {
    return { json: JSON.parse(text) as unknown }
  } catch {
    // A non-JSON answer is not one of Google's resources: a proxy page, or a truncated body.
    throw new BigQueryError("UNAVAILABLE", `Google's answer for ${task} was not JSON`, undefined, { googleError: { message: cut(text, 500), trust: "untrusted" } })
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

const tooLarge = (task: string) => new BigQueryError("UNAVAILABLE", `Google's answer for ${task} was larger than 10 MiB`)

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

/** A backoff that a stop ends at once, so a stopped call never waits out its sleep (L-2). */
/** A delay that a stop ends at once. */
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal.aborted) throw cancelled()
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      done()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      fail(cancelled())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** One attempt's deadline: a stalled connection is retried instead of waiting for the socket's own limit (L-2). */
function withDeadline(signal: AbortSignal, ms: number) {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, Math.max(1, ms))
  const onAbort = () => controller.abort()
  signal.addEventListener("abort", onAbort, { once: true })
  return {
    signal: controller.signal,
    expired: () => expired,
    done: () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    },
  }
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
