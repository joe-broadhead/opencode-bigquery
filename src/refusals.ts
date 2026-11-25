// One place maps the plugin's own codes to the contract's table (contract §12) and builds the refusal the register
// reports. A code the table does not hold would be `UNAVAILABLE`; mapping here keeps each failure's own meaning and its
// next step instead.

import type { ErrorCode as ContractCode } from "@we-the-rebel-alliance/plugin-contract/events";
import { RegisterError, refusal } from "@we-the-rebel-alliance/plugin-contract/register";
import { BigQueryError, type ErrorCode } from "./domain/errors.js";

/** True for the plugin's own error, including one from another copy of the class in a bundle. */
function isBigQueryError(error: unknown): error is BigQueryError {
  return error instanceof BigQueryError || (error instanceof Error && error.name === "BigQueryError" && "code" in error && "detail" in error && "next" in error);
}

/** Each plugin code's contract code, and why the table has no better one. */
const MAPPED: Readonly<Record<ErrorCode, ContractCode>> = {
  HOST_UNTESTED: "HOST_UNTESTED",
  OPTIONS_INVALID: "OPTIONS_INVALID",
  INPUT_INVALID: "INPUT_INVALID",
  ACCOUNT_REQUIRED: "ACCOUNT_REQUIRED",
  ACCOUNT_UNKNOWN: "ACCOUNT_UNKNOWN",
  CANCELLED: "UNAVAILABLE",
  AUTH_REQUIRED: "NEEDS_SIGN_IN",
  AUTH_SCOPE_MISSING: "SCOPE_MISSING",
  AUTH_CLIENT_REQUIRED: "NEEDS_SIGN_IN",
  ACCOUNT_READ_ONLY: "PERMISSION_DENIED",
  WRITE_LEVEL_UNVERIFIED: "PERMISSION_DENIED",
  WRITE_LEVEL_UNAVAILABLE: "PERMISSION_DENIED",
  BILLING_PROJECT_REQUIRED: "INPUT_INVALID",
  API_DISABLED: "UNAVAILABLE",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  COLUMN_DENIED: "PERMISSION_DENIED",
  DATASET_FENCED: "PERMISSION_DENIED",
  NOT_FOUND: "INPUT_INVALID",
  SQL_INVALID: "INPUT_INVALID",
  DRY_RUN_INCOMPLETE: "INPUT_INVALID",
  LEGACY_SQL_REFUSED: "INPUT_INVALID",
  STATEMENT_NOT_READ: "INPUT_INVALID",
  NEEDS_PLAN: "INPUT_INVALID",
  CAP_NOT_ENFORCEABLE: "INPUT_INVALID",
  STATEMENT_UNKNOWN: "INPUT_INVALID",
  SCRIPT_REFUSED: "INPUT_INVALID",
  SCRIPT_CAP_REQUIRED: "INPUT_INVALID",
  SCRIPT_NOT_DRY_RUNNABLE: "INPUT_INVALID",
  CATEGORY_MISMATCH: "INPUT_INVALID",
  COST_CAP: "BUDGET_EXCEEDED",
  BYTES_BILLED_LIMIT: "BUDGET_EXCEEDED",
  BUDGET_REACHED: "BUDGET_EXCEEDED",
  QUOTA_EXCEEDED: "BUDGET_EXCEEDED",
  RATE_LIMITED: "RATE_LIMITED",
  JOB_FAILED: "UNAVAILABLE",
  JOB_TIMEOUT: "UNAVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  CLASSIFICATION_DRIFT: "UNAVAILABLE",
  SAVE_PATH_REFUSED: "INPUT_INVALID",
  SAVE_EXISTS: "INPUT_INVALID",
  SAVE_LIMIT: "TOO_LARGE",
  RESULTS_EXPIRED: "INPUT_INVALID",
  PLAN_INVALID: "PLAN_INVALID",
  PLAN_USED: "PLAN_USED",
  PLAN_CHANGED: "PLAN_INVALID",
  ADMIN_DISABLED: "INPUT_INVALID",
  ADMIN_REASON_REQUIRED: "INPUT_INVALID",
};

/** The contract refusal for a plugin error. */
export function refusalFor(error: BigQueryError): RegisterError {
  const code = MAPPED[error.code];
  const what = error.extras.googleError?.message !== undefined ? `${error.detail} (Google: ${error.extras.googleError.message.slice(0, 120)})` : error.detail;
  return new RegisterError(refusal(code, what, error.next));
}

/**
 * Run a handler and map every plugin failure to the contract's table. Any other error is left to the register, which
 * reports it as `UNAVAILABLE` with a redacted line.
 */
export function mapped<A extends unknown[], R>(run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await run(...args);
    } catch (error) {
      if (isBigQueryError(error)) throw refusalFor(error);
      throw error;
    }
  };
}
