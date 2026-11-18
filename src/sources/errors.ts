/**
 * The source contract's refusals (design §10, §11): a `SourceError` in the family's form
 * `CODE: What happened. Next step: What to do.`, with the contract's own code table. `SOURCE_CODE` in
 * `src/domain/errors.ts` (Day 0) says which contract code each of this plugin's codes becomes; a code it does not name
 * is `UNAVAILABLE` to a source, so the few source-only cases are decided here.
 *
 * Google's own text never appears: it lives in `googleError` on a tool result (§5.6), and the source contract has no
 * such field.
 */
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import { BigQueryError, SOURCE_CODE, type ErrorCode } from "../domain/errors.js"

/** A source-contract refusal, in this plugin's own words. */
export function sourceError(code: string, what: string, next: string, extra: { readonly retryAfterSec?: number } = {}): SourceError {
  return new SourceError({ code, what, next, ...(extra.retryAfterSec === undefined ? {} : { retryAfterSec: extra.retryAfterSec }) })
}

/**
 * The contract code a plugin failure is. `SOURCE_CODE` is the one table, with two source-only readings added: a missing
 * billing project and a missing object are the person's input to fix (`INPUT_INVALID`), not a transient provider fault.
 */
export function sourceCodeOf(error: BigQueryError): string {
  if (error.code === "BILLING_PROJECT_REQUIRED" || error.code === "NOT_FOUND") return "INPUT_INVALID"
  return SOURCE_CODE[error.code as ErrorCode] ?? "UNAVAILABLE"
}

/** A failure as the contract's error: the plugin's wording, the contract's code, the retry when Google gave one. */
export function sourceErrorOf(error: unknown): SourceError {
  if (error instanceof SourceError) return error
  if (error instanceof BigQueryError) {
    const retry = error.extras.retryAfterSec
    return sourceError(sourceCodeOf(error), error.detail, error.next, retry === undefined ? {} : { retryAfterSec: retry })
  }
  return sourceError("UNAVAILABLE", "The provider call failed.", "Call the source again later.")
}

/** The state a source code carries when it reaches the model as a tool result (design §4). */
const FAILED = new Set(["RATE_LIMITED", "UNAVAILABLE", "SCHEMA_VIOLATION"])

/** A source refusal as the model's result envelope: the model path returns results, the tools RPC throws. */
export function toolEnvelope(error: SourceError): Record<string, unknown> {
  return {
    state: FAILED.has(error.code) ? "failed" : "refused",
    error: error.code,
    message: error.what,
    next: error.next,
    ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
  }
}
