/**
 * Every error the plugin raises, in one table: what the code means and what to do next. A message reads
 * `CODE: What happened. Next step: What to do.` The tool adapter turns it into a tool error with metadata
 * `{ code, next }`; the README's Troubleshooting table and docs/configuration.md's Errors table list exactly these codes.
 *
 * `message` and `next` are built only from codes and validated identifiers, never from Google's text or the data.
 * This module imports nothing, so scripts can load it directly.
 */

interface ErrorEntry {
  /** What the code means, for people reading the docs. */
  readonly meaning: string
  /** The default next step; a raise site may give a more specific one built from validated identifiers. */
  readonly next: string
}

export const ErrorCode = {
  // ── Setup: these stop the plugin from loading, or are shown by status ──
  HOST_UNTESTED: {
    meaning: "The OpenCode version is outside the supported range (>=2.2.3 <2.4.0).",
    next: "Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.",
  },
  OPTIONS_INVALID: {
    meaning: "The plugin options are not valid: an unknown key, a wrong type, or a value out of range.",
    next: "Fix the plugin options in opencode.json; the message names the option.",
  },
  SKILLS_INVALID: {
    meaning: "A skill file that ships with the plugin is missing or unreadable.",
    next: "Reinstall the plugin.",
  },
  RULES_NOT_ADDED: {
    meaning: "The default permission rules could not be added to the agents, so BigQuery tools may run without asking.",
    next: "Restart OpenCode.",
  },
  STATUS_UNAVAILABLE: {
    meaning: "The status could not be computed.",
    next: "Try again in a few seconds; if it persists, restart OpenCode.",
  },
  TOOLS_NOT_REGISTERED: {
    meaning: "The plugin's tools could not be registered with OpenCode.",
    next: "Restart OpenCode.",
  },

  // ── Requests ──────────────────────────────────────────────────────────
  INPUT_INVALID: {
    meaning: "The tool's input does not fit its schema; nothing was sent to Google.",
    next: "Check the input against the tool's schema, then call it again.",
  },
} as const satisfies Record<string, ErrorEntry>

export type ErrorCode = keyof typeof ErrorCode

export const ERROR_CODES = Object.keys(ErrorCode).sort() as readonly ErrorCode[]

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ErrorCode, value)
}

/** The one error text: `CODE: What happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: ErrorCode, detail: string, next: string = ErrorCode[code].next) =>
  `${code}: ${sentence(detail)} Next step: ${sentence(next)}`

/** A plugin error: a code from the table, what happened, and the next step. */
export class BigQueryError extends Error {
  readonly code: ErrorCode
  /** What happened, without the code or the next step: the form the tools RPC reports as `what`. */
  readonly detail: string
  readonly next: string

  constructor(code: ErrorCode, detail: string, next?: string) {
    super(errorText(code, detail, next))
    this.name = "BigQueryError"
    this.code = code
    this.detail = sentence(detail)
    this.next = sentence(next ?? ErrorCode[code].next)
  }
}

/** Starts `text` with a capital and ends it with a full stop unless it already ends a sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim()
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}
