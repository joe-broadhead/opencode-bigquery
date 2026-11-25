/**
 * Every error the plugin raises, in one table: what the code means, the state a tool result carries with it, and what
 * to do next. A message reads `CODE: What happened. Next step: What to do.` The README's Troubleshooting table and
 * docs/configuration.md's Errors table are generated from this table (`node scripts/docs-errors.mjs`), and a test keeps
 * them equal.
 *
 * `message` and `next` are built only from codes and validated identifiers (`src/domain/identifiers.ts`), never from
 * Google's text or the data: Google's message stays on the error for a log and never enters a refusal's line.
 *
 * `owner` names the package that raises the code (docs/ownership.md); Day 0 raises the setup and contract codes.
 * This module imports nothing, so scripts can load it directly.
 */

/** The state a tool result carries with a code. `setup` codes stop the plugin from loading, or are shown by status. */
export type ErrorState = "refused" | "failed" | "cancelled" | "setup"
export type Owner = "day0" | "A" | "B" | "C" | "D" | "E" | "F"

interface ErrorEntry {
  /** What the code means, for people reading the docs. */
  readonly meaning: string
  /** The default next step; a raise site may give a more specific one built from validated identifiers. */
  readonly next: string
  readonly state: ErrorState
  readonly owner: Owner
}

export const ErrorCode = {
  // ── Setup ─────────────────────────────────────────────────────────────
  HOST_UNTESTED: {
    meaning: "The OpenCode version is outside the supported range (>=2.4.1 <2.5.0).",
    next: "Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.",
    state: "setup",
    owner: "day0",
  },
  OPTIONS_INVALID: {
    meaning:
      "The plugin options are not valid: an unknown key, a wrong type, a value out of range, a write level on a headless account, or a secret where none belongs.",
    next: "Fix the plugin options in opencode.json; the message names the option.",
    state: "setup",
    owner: "day0",
  },

  // ── Requests ──────────────────────────────────────────────────────────
  INPUT_INVALID: {
    meaning: "The tool's input does not fit its schema, or a saved query cannot be read as a source; nothing was sent to Google.",
    next: "Check the input against the tool's schema, then call it again.",
    state: "refused",
    owner: "day0",
  },
  ACCOUNT_REQUIRED: {
    meaning: "More than one account is configured and the call named none.",
    next: "Pass account with one of the configured aliases; status lists them.",
    state: "refused",
    owner: "day0",
  },
  ACCOUNT_UNKNOWN: {
    meaning: "The account alias is not configured.",
    next: "Pass a configured alias; status lists them.",
    state: "refused",
    owner: "day0",
  },
  CANCELLED: {
    meaning: "The call was stopped; a job it started was cancelled, and what it billed is unknown.",
    next: "Do not retry unless the user asks; jobs shows what ran.",
    state: "cancelled",
    owner: "B",
  },

  // ── Sign-in and levels ────────────────────────────────────────────────
  AUTH_REQUIRED: {
    meaning:
      "No usable credential: the account is not signed in, its sign-in expired, the headless variable is unset, or the organisation limits Cloud sessions and wants a new sign-in.",
    next: "Ask the user to run /connect and choose BigQuery; for a headless account, set the variable the message names.",
    state: "refused",
    owner: "A",
  },
  AUTH_SCOPE_MISSING: {
    meaning: "The granted scopes lack one this call needs, such as bigquery unticked on Google's consent screen. Google was not called.",
    next: "Ask the user to sign in again and approve every scope listed.",
    state: "refused",
    owner: "A",
  },
  AUTH_CLIENT_REQUIRED: {
    meaning: "No OAuth client is configured, none was entered in the form, and no earlier sign-in has one.",
    next: "Enter a Desktop OAuth client in /connect, or set the oauthClient option.",
    state: "refused",
    owner: "A",
  },
  ACCOUNT_READ_ONLY: {
    meaning: "A commit on a Read account, or on any headless account. Nothing was sent to Google.",
    next: "Tell the user; only they can sign in again choosing Read and write.",
    state: "refused",
    owner: "day0",
  },
  WRITE_LEVEL_UNVERIFIED: {
    meaning:
      "The sign-in record says Read and write, but the scopes Google returned at this process's last refresh lack the write marker. Nothing was sent.",
    next: "Tell the user; they sign in again choosing Read and write and approve Google's consent screen.",
    state: "refused",
    owner: "day0",
  },
  WRITE_LEVEL_UNAVAILABLE: {
    meaning: "This release ships with the Read and write level turned off, because Google does not keep the two levels apart on a shared client.",
    next: "Tell the user; changes are made in the Google Cloud console or with bq for now.",
    state: "refused",
    owner: "day0",
  },

  // ── Google ────────────────────────────────────────────────────────────
  BILLING_PROJECT_REQUIRED: {
    meaning: "The account has no billing project, so a query cannot run.",
    next: "Call list({}) to see the projects, then set billingProject on the account.",
    state: "refused",
    owner: "C",
  },
  API_DISABLED: {
    meaning: "The BigQuery API is off in the project.",
    next: "Ask the user to enable the BigQuery API in the Google Cloud console, wait a minute, and retry.",
    state: "refused",
    owner: "B",
  },
  PERMISSION_DENIED: {
    meaning: "IAM refused the call (the permission is named), or the call needs an approval that a script cannot give.",
    next: "Ask an admin for the named role; from a script, run the call from a session instead.",
    state: "refused",
    owner: "B",
  },
  COLUMN_DENIED: {
    meaning: "The query reads policy-tagged columns the caller cannot read.",
    next: "Leave those columns out with SELECT * EXCEPT (…), or ask for Fine-Grained Reader.",
    state: "refused",
    owner: "C",
  },
  DATASET_FENCED: {
    meaning: "A referenced object is outside the account's dataset fence, or a person's rule denied it.",
    next: "Query allowed datasets, or ask the user to change the account's datasets option.",
    state: "refused",
    owner: "C",
  },
  NOT_FOUND: {
    meaning: "The project, dataset, table, routine or job was not found.",
    next: "Find the exact name with list or search.",
    state: "refused",
    owner: "B",
  },
  SQL_INVALID: {
    meaning: "The dry run or the lexer rejected the SQL; the line and column are given.",
    next: "Fix the SQL at that position; table shows the names.",
    state: "refused",
    owner: "C",
  },
  DRY_RUN_INCOMPLETE: {
    meaning: "The dry run returned no query statistics, so the checks cannot run.",
    next: "Retry once; if it repeats, report it.",
    state: "refused",
    owner: "C",
  },
  LEGACY_SQL_REFUSED: {
    meaning: "The query is legacy SQL, which the plugin never runs.",
    next: "Rewrite it in GoogleSQL.",
    state: "refused",
    owner: "C",
  },
  STATEMENT_NOT_READ: {
    meaning: "query got a change or a script.",
    next: "Call plan({ sql }), show the preview to the user, then call the commit tool it names.",
    state: "refused",
    owner: "C",
  },
  NEEDS_PLAN: {
    meaning:
      "A read whose cost the cap cannot bound, that has external effects, or whose references could not be resolved; the reason is CAP_NOT_ENFORCEABLE, EXTERNAL_EFFECTS or UNRESOLVED_REFERENCE.",
    next: "Call plan({ sql }) and show the user the preview; with their go-ahead, query({ planId }) for CAP_NOT_ENFORCEABLE, or the commit tool named for the others.",
    state: "refused",
    owner: "C",
  },
  CAP_NOT_ENFORCEABLE: {
    meaning: "In a source, or with uncappedReads set to refuse: the cap cannot bound this query, and it cannot run from a plan here.",
    next: "Change the query to read native tables without row access policies.",
    state: "refused",
    owner: "C",
  },
  STATEMENT_UNKNOWN: {
    meaning: "A statement type this version does not classify.",
    next: "Run it in the Google Cloud console or with bq, and update the plugin.",
    state: "refused",
    owner: "D",
  },
  SCRIPT_REFUSED: {
    meaning: "Scripts are turned off by the scripts option.",
    next: "Split the script into single statements.",
    state: "refused",
    owner: "D",
  },
  SCRIPT_CAP_REQUIRED: {
    meaning: "A script was planned without maxBytes.",
    next: "Plan it again with maxBytes.",
    state: "refused",
    owner: "D",
  },
  SCRIPT_NOT_DRY_RUNNABLE: {
    meaning: "BigQuery cannot dry-run this script, such as one with CREATE TEMP TABLE.",
    next: "Replace the temporary table with a CTE or a dataset table, then plan again.",
    state: "refused",
    owner: "D",
  },
  CATEGORY_MISMATCH: {
    meaning: "A plain read sent to plan, or a plan committed with another category's tool.",
    next: "Call the tool the message names.",
    state: "refused",
    owner: "day0",
  },
  COST_CAP: {
    meaning: "The estimate is over the cap; the estimate, the cap and hints are given.",
    next: "Narrow the query, or pass maxBytes up to the ceiling.",
    state: "refused",
    owner: "C",
  },
  BYTES_BILLED_LIMIT: {
    meaning: "Google stopped the job at its byte cap; nothing was billed.",
    next: "Narrow the query, or pass maxBytes up to the ceiling.",
    state: "failed",
    owner: "B",
  },
  BUDGET_REACHED: {
    meaning: "The opt-in budget is spent.",
    next: "Wait for the reset, or ask the user to raise budget.",
    state: "refused",
    owner: "C",
  },
  QUOTA_EXCEEDED: {
    meaning: "A Google quota is reached, such as a custom daily query quota.",
    next: "Quotas reset at midnight Pacific time; try again then.",
    state: "refused",
    owner: "B",
  },
  RATE_LIMITED: {
    meaning: "Google's rate limit held after retries; retryAfterSec says how long to wait.",
    next: "Make the same call later.",
    state: "failed",
    owner: "B",
  },
  JOB_FAILED: {
    meaning: "The job failed; Google's reason stays on the error, not in the refusal.",
    next: "Fix the query and run it again; job shows the job.",
    state: "failed",
    owner: "B",
  },
  JOB_TIMEOUT: {
    meaning: "The job reached its time limit; the bytes billed so far are given.",
    next: "Narrow the query, or pass a longer jobTimeoutSeconds.",
    state: "failed",
    owner: "B",
  },
  UNAVAILABLE: {
    meaning: "Google answered with a server error after retries, or the network failed.",
    next: "Try again later.",
    state: "failed",
    owner: "B",
  },
  CLASSIFICATION_DRIFT: {
    meaning: "What ran differed from its dry run: another statement type, or a view or routine expansion did not see. It was recorded.",
    next: "jobs shows what ran; report it.",
    state: "failed",
    owner: "C",
  },

  // ── Files ─────────────────────────────────────────────────────────────
  SAVE_PATH_REFUSED: {
    meaning: "The save path is outside the allowed roots, or is a symbolic link.",
    next: "Save to a path inside the project, or one under allowedRoots.",
    state: "refused",
    owner: "E",
  },
  SAVE_EXISTS: {
    meaning: "The save path exists and overwrite is not set.",
    next: "Choose another path, or pass overwrite: true after the user agrees.",
    state: "refused",
    owner: "E",
  },
  SAVE_LIMIT: {
    meaning: "The result is over maxSaveRows or maxSaveBytes; the partial file was removed.",
    next: "Narrow the query, or ask the user to raise the save limits.",
    state: "refused",
    owner: "E",
  },
  RESULTS_EXPIRED: {
    meaning: "The job's result table is gone; it expires 24 hours after the original run.",
    next: "Run the query again.",
    state: "refused",
    owner: "E",
  },

  // ── Plans ─────────────────────────────────────────────────────────────
  PLAN_CHANGED: {
    meaning: "The commit's dry run differs from the plan's: its type, targets, location, cap or an estimate over 10 percent higher.",
    next: "Plan again and show the new preview.",
    state: "refused",
    owner: "D",
  },
  ADMIN_DISABLED: {
    meaning: "Admin statements are turned off by the plugin's admin option.",
    next: "Ask the user to set admin.enabled to true.",
    state: "refused",
    owner: "D",
  },
  PLAN_INVALID: {
    meaning: "The plan a commit named is missing, expired, already spent, or belongs to another method.",
    next: "Plan the change again, then commit with the planId the planner answers.",
    state: "refused",
    owner: "day0",
  },
  PLAN_USED: {
    meaning: "The plan a commit named was already spent.",
    next: "Plan the change again; a plan commits once.",
    state: "refused",
    owner: "day0",
  },
  ADMIN_REASON_REQUIRED: {
    meaning: "An admin plan was made without reason.",
    next: "Plan again with reason.",
    state: "refused",
    owner: "D",
  },
} as const satisfies Record<string, ErrorEntry>

export type ErrorCode = keyof typeof ErrorCode

export const ERROR_CODES = Object.keys(ErrorCode).sort() as readonly ErrorCode[]

/** Warnings: a result that ran, with something the model should know. Never a refusal. */
export const WarningCode = {
  ESTIMATE_LOWER_BOUND: "The estimate is a lower bound, such as for an external source.",
  BUDGET_WARN: "The budget is nearly spent.",
  CACHE_MISS_EXPECTED: "The query cannot use the cache, so it bills each time it runs.",
  POLICY_TAGGED_SOURCE: "A referenced table has policy-tagged columns the query might read, so no rows are inline; save the result instead.",
  INLINE_DENIED: "A referenced dataset is save-only by the account's inline option, so no rows are inline.",
  HEADLESS_IDENTITY: "Queries run as the headless principal, not as the person.",
  SCOPE_WIDER_THAN_LEVEL: "The credential has wider scopes than its level needs, such as cloud-platform.",
  IDENTITY_CAN_WRITE: "The identity can change data where the check looked; only IAM stops it outside the plugin.",
} as const

export type WarningCode = keyof typeof WarningCode
export const WARNING_CODES = Object.keys(WarningCode).sort() as readonly WarningCode[]

/** Why a read needs a plan (`NEEDS_PLAN`'s `reason`). */
export const NEEDS_PLAN_REASONS = ["CAP_NOT_ENFORCEABLE", "EXTERNAL_EFFECTS", "UNRESOLVED_REFERENCE"] as const
export type NeedsPlanReason = (typeof NEEDS_PLAN_REASONS)[number]


export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ErrorCode, value)
}

/** The one error text: `CODE: What happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: ErrorCode, detail: string, next: string = ErrorCode[code].next) =>
  `${code}: ${sentence(detail)} Next step: ${sentence(next)}`

/** Google's own error, kept apart from `message` and `next` because it can carry data (`ERROR(CONCAT(...))`). */
export interface GoogleErrorText {
  readonly reason?: string
  readonly location?: string
  /** Google's message, cut to 500 characters. Untrusted. */
  readonly message?: string
  readonly trust: "untrusted"
}

export interface ErrorExtras {
  /** For NEEDS_PLAN. */
  readonly reason?: NeedsPlanReason
  /** For RATE_LIMITED. */
  readonly retryAfterSec?: number
  readonly googleError?: GoogleErrorText
}

/** A plugin error: a code from the table, what happened, and the next step. */
export class BigQueryError extends Error {
  readonly code: ErrorCode
  /** What happened, without the code or the next step: the form the tools RPC reports as `what`. */
  readonly detail: string
  readonly next: string
  readonly state: ErrorState
  readonly extras: ErrorExtras

  constructor(code: ErrorCode, detail: string, next?: string, extras: ErrorExtras = {}) {
    super(errorText(code, detail, next))
    this.name = "BigQueryError"
    this.code = code
    this.detail = sentence(detail)
    this.next = sentence(next ?? ErrorCode[code].next)
    this.state = ErrorCode[code].state
    this.extras = extras
  }
}

/** Starts `text` with a capital and ends it with a full stop unless it already ends a sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim()
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}
