/**
 * A SQL routine's body as a statement BigQuery's own dry run can analyse, so the tables, views and routines the body
 * reaches come from Google's `referencedTables`, `referencedLogicalViews` and `referencedRoutines` rather than from
 * reading the body's text (review bigquery-3 R-1: every local parse of `FROM` missed some form).
 *
 * Google's Job resource documents `referencedTables` only as "Referenced tables for the job", and says nothing on
 * whether a query's list includes what a persistent function's body reads. So each SQL routine the dry run names is
 * analysed on its own:
 *
 * - the Routine resource's `definitionBody` is, for SQL, "the substring inside (but excluding) the parentheses" of the
 *   `AS` clause: an expression for a scalar function, a query for a table function;
 * - each argument the body uses is replaced by a typed `NULL` (`CAST(NULL AS <type>)` from its `StandardSqlDataType`,
 *   or a bare `NULL` for an `ANY TYPE` argument), which changes no `FROM` item: a table path is never an argument name;
 * - a scalar function's expression is wrapped as `SELECT (<body>)`; a table function's query is used as it is.
 *
 * The lexer's only part is finding the argument names among the tokens. Whatever cannot be built — a procedure, an
 * unknown routine type, a table-typed argument, a body that does not lex — is `undefined`, and expansion marks the
 * routine unresolved, so the read goes to a plan. A substitution that makes the body invalid fails the dry run, which is
 * unresolved too: nothing is assumed.
 */
import type { Lexer, Token } from "../domain/lexer-api.js"
import type { RoutineInfo } from "../domain/google.js"
import { quoteIdent } from "./sql.js"

/** The scalar `typeKind` values of Google's `StandardSqlDataType`, written as GoogleSQL writes them. */
const SCALAR_KINDS: ReadonlySet<string> = new Set([
  "INT64",
  "BOOL",
  "FLOAT64",
  "STRING",
  "BYTES",
  "TIMESTAMP",
  "DATE",
  "TIME",
  "DATETIME",
  "GEOGRAPHY",
  "NUMERIC",
  "BIGNUMERIC",
  "JSON",
  "INTERVAL",
])

interface StandardSqlDataType {
  readonly typeKind?: unknown
  readonly arrayElementType?: unknown
  readonly structType?: { readonly fields?: readonly { readonly name?: unknown; readonly type?: unknown }[] }
  readonly rangeElementType?: unknown
}

/** A `StandardSqlDataType` as a GoogleSQL type, built only from Google's enum and escaped field names; else undefined. */
export function sqlTypeOf(dataType: unknown, depth = 0): string | undefined {
  if (depth > 16 || typeof dataType !== "object" || dataType === null) return undefined
  const type = dataType as StandardSqlDataType
  const kind = typeof type.typeKind === "string" ? type.typeKind.toUpperCase() : ""
  if (SCALAR_KINDS.has(kind)) return kind
  if (kind === "ARRAY") {
    const element = sqlTypeOf(type.arrayElementType, depth + 1)
    return element === undefined ? undefined : `ARRAY<${element}>`
  }
  if (kind === "RANGE") {
    const element = sqlTypeOf(type.rangeElementType, depth + 1)
    return element === undefined ? undefined : `RANGE<${element}>`
  }
  if (kind === "STRUCT") {
    const fields = type.structType?.fields ?? []
    const parts: string[] = []
    for (const field of fields) {
      const inner = sqlTypeOf(field.type, depth + 1)
      if (inner === undefined) return undefined
      parts.push(typeof field.name === "string" && field.name !== "" ? `${quoteIdent(field.name)} ${inner}` : inner)
    }
    return parts.length === 0 ? undefined : `STRUCT<${parts.join(", ")}>`
  }
  return undefined
}

interface Argument {
  readonly name?: string
  readonly argumentKind?: string
  readonly dataType?: unknown
}

/** The text each argument becomes, by upper-cased name; undefined when an argument cannot be stood in for. */
function standIns(routine: RoutineInfo): Map<string, string> | undefined {
  const out = new Map<string, string>()
  for (const raw of (routine.arguments ?? []) as readonly Argument[]) {
    if (typeof raw.name !== "string" || raw.name === "") continue
    const kind = (raw.argumentKind ?? "FIXED_TYPE").toUpperCase()
    // A table argument (`FIXED_TABLE`, `ANY_TABLE`) is a relation, not a value: no NULL stands in for it.
    if (kind.includes("TABLE")) return undefined
    if (kind === "ANY_TYPE") {
      out.set(raw.name.toUpperCase(), "(NULL)")
      continue
    }
    const type = sqlTypeOf(raw.dataType)
    out.set(raw.name.toUpperCase(), type === undefined ? "(NULL)" : `(CAST(NULL AS ${type}))`)
  }
  return out
}

/** The offset in `text` of a token's 1-based line and column, as the lexer counts them. */
function offsetsOf(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") starts.push(index + 1)
  return starts
}

const isPunct = (token: Token | undefined, text: string) => token !== undefined && (token.kind === "punctuation" || token.kind === "operator") && token.text === text

/** The argument name a token is, upper-cased, when it is a bare or single-part backquoted name. */
function nameOf(token: Token): string | undefined {
  if (token.kind === "identifier" || token.kind === "keyword") return token.value.toUpperCase()
  if (token.kind === "quoted" && token.parts?.length === 1) return token.parts[0]!.toUpperCase()
  return undefined
}

/**
 * The statement whose dry run names what a SQL routine's body reads, or undefined when none can be built (the routine
 * is then unresolved). `lexer` finds the argument names; nothing else in the body is interpreted here.
 */
export function routineProbeSql(routine: RoutineInfo, lexer: Lexer): string | undefined {
  const body = routine.definitionBody
  if (body === undefined || body.trim() === "") return undefined
  const type = (routine.routineType ?? "").toUpperCase()
  if (type !== "SCALAR_FUNCTION" && type !== "TABLE_VALUED_FUNCTION") return undefined
  const args = standIns(routine)
  if (args === undefined) return undefined
  const lexed = lexer.lex(body)
  if (!lexed.ok) return undefined

  const significant = lexed.tokens.filter((token) => token.kind !== "comment")
  const lines = offsetsOf(body)
  const edits: { start: number; end: number; text: string }[] = []
  for (let index = 0; index < significant.length; index += 1) {
    const token = significant[index]!
    const name = nameOf(token)
    if (name === undefined) continue
    const standIn = args.get(name)
    if (standIn === undefined) continue
    // `t.x` is a field of something else, and `x(` is a call: neither is the argument.
    if (isPunct(significant[index - 1], ".") || isPunct(significant[index + 1], "(")) continue
    const start = (lines[token.line - 1] ?? 0) + token.column - 1
    edits.push({ start, end: start + token.text.length, text: standIn })
  }
  let text = body
  for (const edit of edits.sort((left, right) => right.start - left.start)) text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`

  // A newline before the closing parenthesis, so a trailing `--` comment in the body cannot swallow it.
  return type === "SCALAR_FUNCTION" ? `SELECT (\n${text}\n)` : text
}
