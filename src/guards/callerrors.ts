/**
 * Failures that end the whole call rather than one object's analysis. When a table cannot be read because the account
 * is not signed in, a quota is spent or Google is down, the honest answer is that error — not `NEEDS_PLAN`, which would
 * tell the user to plan around a problem that a retry fixes. Everything else (a permission on one view, a missing
 * definition) is the object's own answer and is resolved as `UNRESOLVED_REFERENCE` (design §5.1 step 4).
 */
import { BigQueryError, type ErrorCode } from "../domain/errors.js"

const CALL_FAILURES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "AUTH_REQUIRED",
  "AUTH_SCOPE_MISSING",
  "AUTH_CLIENT_REQUIRED",
  "ADC_UNAVAILABLE",
  "ADC_REFUSED",
  "API_DISABLED",
  "BILLING_PROJECT_REQUIRED",
  "CANCELLED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "UNAVAILABLE",
])

export function isCallFailure(error: unknown): boolean {
  return error instanceof BigQueryError ? CALL_FAILURES.has(error.code) : false
}

/** Rethrows a call-wide failure; returns silently for an object's own failure. */
export function rethrowCallFailure(error: unknown): void {
  if (isCallFailure(error)) throw error
}

/** Any throw from a port as the plugin's own error, so a handler never answers with a foreign error's words. */
export function asCallError(error: unknown, detail: string): BigQueryError {
  if (error instanceof BigQueryError) return error
  return new BigQueryError("UNAVAILABLE", detail)
}
