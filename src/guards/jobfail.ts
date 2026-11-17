/**
 * A job that ended in error, as the plugin's own code (design §11). Google's reason picks the code, never its message:
 * the reason is included in `message` only when it is a plain identifier, and Google's text goes into `googleError` with
 * `trust: "untrusted"`, cut to 500 characters.
 */
import { BigQueryError, type ErrorCode, type ErrorExtras } from "../domain/errors.js"
import type { GoogleErrorProto } from "../domain/google.js"
import type { JobStatus } from "../ports.js"

const REASON_CODES: Readonly<Record<string, ErrorCode>> = {
  bytesBilledLimitExceeded: "BYTES_BILLED_LIMIT",
  quotaExceeded: "QUOTA_EXCEEDED",
  rateLimitExceeded: "RATE_LIMITED",
  accessDenied: "PERMISSION_DENIED",
  notFound: "NOT_FOUND",
  invalidQuery: "SQL_INVALID",
  invalid: "SQL_INVALID",
  backendError: "UNAVAILABLE",
  internalError: "UNAVAILABLE",
  jobBackendError: "UNAVAILABLE",
  stopped: "CANCELLED",
  cancelled: "CANCELLED",
  timeout: "JOB_TIMEOUT",
}

const PLAIN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const POLICY_TAG = /policy\s*tags?|policyTags?\//i

/** Google's error as the envelope carries it: untrusted, cut, never in `message`. */
export function googleErrorText(error: GoogleErrorProto | undefined): ErrorExtras["googleError"] | undefined {
  if (!error) return undefined
  return {
    ...(error.reason !== undefined ? { reason: error.reason.slice(0, 64) } : {}),
    ...(error.location !== undefined ? { location: error.location.slice(0, 256) } : {}),
    ...(error.message !== undefined ? { message: error.message.slice(0, 500) } : {}),
    trust: "untrusted",
  }
}

/** The failure a finished job's error is, or undefined when it has none. */
export function failureFor(status: JobStatus): BigQueryError | undefined {
  const error = status.error
  if (!error) return undefined
  const reason = error.reason
  let code: ErrorCode = (reason !== undefined ? REASON_CODES[reason] : undefined) ?? "JOB_FAILED"
  // A column-level denial is a different next step from a dataset-level one.
  if (code === "PERMISSION_DENIED" && reason === "accessDenied" && error.message !== undefined && POLICY_TAG.test(error.message)) code = "COLUMN_DENIED"
  const detail = reason !== undefined && PLAIN.test(reason) ? `The job ended with ${reason}` : "The job failed"
  const googleError = googleErrorText(error)
  return new BigQueryError(code, detail, undefined, googleError ? { googleError } : {})
}
