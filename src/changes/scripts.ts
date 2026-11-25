/**
 * A script's statements, for the preview the person approves and for the fence (review bigquery-8 H-1, M-1).
 *
 * BigQuery's dry run of a whole script stops at the first DDL/CALL/EXECUTE IMMEDIATE/FOR/IF/WHILE (design §5.2,
 * https://cloud.google.com/bigquery/docs/multi-statement-queries), so it cannot name the targets of the statements after
 * that point. Each top-level statement is therefore dry-run on its own (free) to get its `statementType` and its target
 * fields. Splitting is wording only: the lexer's tokens, split on `;` at parenthesis depth 0, with every string and
 * comment a single token. A statement whose own dry run fails (a `DECLARE`d variable, a temporary table, a BEGIN block's
 * fragment) is marked undetermined; a fence refuses the plan rather than assume.
 *
 * This is never used to *allow* anything: the whole script's `prepareRead` still decides its type, referenced set, cap
 * and side effects, and each statement's targets are additional objects for the fence and the person's rules.
 */
import { BigQueryError } from "../domain/errors.js"
import type { QueryParameter } from "../domain/google.js"
import type { Token } from "../domain/lexer-api.js"
import { rethrowCallFailure } from "../guards/callerrors.js"
import { createLexer, significantTokens } from "../guards/lexer.js"
import { statementSources, statementTarget } from "./statement-target.js"
import { changeTargets, referencesOf, sameTargets, type Target, targetsOf } from "./statistics.js"

/** How many statements a script may have for its preview and its per-statement targets. */
export const MAX_SCRIPT_STATEMENTS = 64

/** The longest first line the preview shows for one statement, in characters. */
const FIRST_LINE = 100

/** One statement of a script: its text, the dry run's type, and the targets the dry run named. */
export interface ScriptStatementInput {
  readonly text: string
  readonly firstLine: string
  readonly type: string
  readonly targets: readonly Target[]
  /** The tables, views and routines this statement reads, for the fence and a person's rules (package C covers the whole
   * script only up to the point its dry run stops, so a later statement's reads are here). */
  readonly references: readonly Target[]
  /** False when the statement's own dry run failed or answered no statistics; a fence refuses then. */
  readonly determined: boolean
  /** A CLONE/COPY clause whose source could not be read; a fence refuses the statement then (review #8 R-1). */
  readonly sourceMissing: boolean
}

/** A script's own dry run, as the statement dry runs need it. */
export interface ScriptInput {
  readonly ports: import("../ports.js").Ports
  readonly account: string
  readonly project: string
  readonly location?: string
  /** The script's parameters, converted as the whole script's dry run takes them. */
  readonly params?: readonly QueryParameter[]
  readonly signal: AbortSignal
  readonly sql: string
}

/**
 * The script's top-level statements, in order, split on `;` at parenthesis depth 0. Quotes, backquoted paths and comments
 * are single tokens from package C's lexer, so a `;` inside them is never a boundary.
 */
export function splitStatements(sql: string): string[] {
  const lexed = createLexer().lex(sql)
  if (!lexed.ok) {
    throw new BigQueryError(
      "SQL_INVALID",
      `The lexer found ${lexed.error.what} at line ${lexed.error.line}, column ${lexed.error.column}`,
      "Fix the SQL at that position; table shows the names.",
    )
  }
  const statements: string[] = []
  let current: Token[] = []
  let depth = 0
  const finish = () => {
    const text = current.map((token) => token.text).join(" ").trim()
    if (text.length > 0) statements.push(text)
    current = []
  }
  for (const token of significantTokens(lexed.tokens)) {
    const punctuation = token.kind === "punctuation" || token.kind === "operator"
    if (punctuation && token.text === "(") depth += 1
    else if (punctuation && token.text === ")") depth = Math.max(0, depth - 1)
    else if (punctuation && token.text === ";" && depth === 0) {
      finish()
      continue
    }
    current.push(token)
  }
  finish()
  return statements
}

/** The statement's first line for the preview: the reconstructed text, cut at a readable length. */
export function firstLine(text: string): string {
  return text.length > FIRST_LINE ? `${text.slice(0, FIRST_LINE - 1)}…` : text
}

/** Every statement of the script, each dry-run on its own for its type and targets. */
export async function scriptStatements(input: ScriptInput): Promise<ScriptStatementInput[]> {
  const texts = splitStatements(input.sql)
  if (texts.length > MAX_SCRIPT_STATEMENTS) {
    throw new BigQueryError(
      "INPUT_INVALID",
      `The script has ${texts.length} statements, and the plugin previews and checks at most ${MAX_SCRIPT_STATEMENTS}`,
      "Split it into smaller scripts, or run it in the Google Cloud console.",
    )
  }
  const out: ScriptStatementInput[] = []
  for (const text of texts) {
    out.push(await oneStatement(input, text))
  }
  return out
}

async function oneStatement(input: ScriptInput, text: string): Promise<ScriptStatementInput> {
  const line = firstLine(text)
  try {
    const answer = await input.ports.bigquery.dryRun(
      {
        account: input.account,
        project: input.project,
        sql: text,
        ...(input.params !== undefined ? { params: input.params } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        useQueryCache: false,
      },
      input.signal,
    )
    const statistics = answer.statistics
    if (statistics === undefined || statistics.statementType === undefined) {
      return { text, firstLine: line, type: "unknown", targets: [], references: [], determined: false, sourceMissing: false }
    }
    const type = statistics.statementType
    const server = targetsOf(statistics, type, statistics.referencedTables ?? [])
    const sources = statementSources(text, type, input.project)
    return {
      text,
      firstLine: line,
      type,
      targets: changeTargets(server, statementTarget(text, type, input.project), sources.targets),
      references: referencesOf(statistics),
      determined: true,
      sourceMissing: sources.required && sources.targets.length === 0,
    }
  } catch (error) {
    // A call-wide failure (auth, quota, network) is the whole plan's; a statement's own SQL error is its own answer,
    // and the statement is undetermined (a fence refuses; without one the preview says so).
    rethrowCallFailure(error)
    return { text, firstLine: line, type: "unknown", targets: [], references: [], determined: false, sourceMissing: false }
  }
}

/** "A script of N statements: <first line>; …", for the plan output's reason and the approval metadata. */
export function scriptSummary(statements: readonly ScriptStatementInput[]): string {
  const lines = statements.map((statement, index) => `${index + 1}. ${statement.firstLine}`).join(" ")
  return `A script of ${statements.length} statement${statements.length === 1 ? "" : "s"}: ${lines}`
}

/** Whether a commit's fresh statements are the plan's: the same count, types and targets, statement by statement. */
export function sameScript(planned: readonly ScriptStatementInput[], fresh: readonly ScriptStatementInput[]): boolean {
  if (planned.length !== fresh.length) return false
  return planned.every((statement, index) => {
    const other = fresh[index]
    return (
      other !== undefined &&
      statement.type === other.type &&
      statement.sourceMissing === other.sourceMissing &&
      sameTargets(statement.targets, other.targets) &&
      sameTargets(statement.references, other.references)
    )
  })
}
