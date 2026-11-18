/**
 * A change's destination from the statement's own leading keywords (review bigquery-8 H-1): `INSERT INTO t`, `UPDATE t`,
 * `DELETE FROM t`, `MERGE INTO t`, `TRUNCATE TABLE t`, `ALTER TABLE t`, `DROP TABLE t`, `LOAD DATA INTO t`, `CALL p`,
 * and the CREATE variants. Google's dry run names no target for most of these (`ddlTargetTable` is present only for
 * CREATE/DROP TABLE or VIEW and DROP ALL ROW ACCESS POLICIES), so without this a fence could not check them at all.
 *
 * This is a **stricter-only addition**: it adds a target to the fence and the person's rules, never removes one, and is
 * used only where the server named none. It reads the tokens after the leading keywords, not a `FROM` clause, so it
 * cannot be confused by joins, subqueries or aliases. A path it cannot resolve (one part without a default dataset, a
 * `_SESSION` temporary table, a wildcard, a decorator it cannot read) is `undefined`, and a fence then fails closed.
 */
import type { Token } from "../domain/lexer-api.js"
import { createLexer, significantTokens } from "../guards/lexer.js"
import type { PlanTarget, Target } from "./statistics.js"

const SAFE_PART = /^[A-Za-z0-9_.:-]{1,1024}$/
const label = (parts: readonly string[]) => parts.map((part) => (SAFE_PART.test(part) ? part : "object")).join(".")

/** The object words whose path this reader can follow; anything else is undetermined (a fence then fails closed). */
const OBJECT_WORDS = new Set(["TABLE", "VIEW", "SCHEMA", "MODEL", "FUNCTION", "PROCEDURE"])

/** The destination a statement's leading keywords name, or undefined when it cannot be read safely. */
export function statementTarget(sql: string, statementType: string, project: string): Target | undefined {
  const lexed = createLexer().lex(sql)
  if (!lexed.ok) return undefined
  const tokens = significantTokens(lexed.tokens)
  const head = word(tokens, 0)
  if (head === undefined) return undefined

  let at = 1
  let kind: PlanTarget["kind"] = "table"
  switch (head) {
    case "INSERT": {
      if (word(tokens, at) === "INTO") at += 1
      break
    }
    case "UPDATE":
      break
    case "DELETE": {
      if (word(tokens, at) === "FROM") at += 1
      break
    }
    case "MERGE": {
      if (word(tokens, at) === "INTO") at += 1
      break
    }
    case "TRUNCATE": {
      if (word(tokens, at) === "TABLE") at += 1
      break
    }
    case "LOAD": {
      if (word(tokens, at) === "DATA") at += 1
      if (word(tokens, at) === "OVERWRITE") at += 1
      if (word(tokens, at) === "INTO") at += 1
      break
    }
    case "ALTER":
    case "DROP": {
      const object = objectWords(tokens, at)
      if (object === undefined) return undefined
      kind = object.kind
      at = object.next
      break
    }
    case "CREATE": {
      if (word(tokens, at) === "OR" && word(tokens, at + 1) === "REPLACE") at += 2
      const object = objectWords(tokens, at)
      if (object === undefined) return undefined
      // A temporary table lives in a hidden dataset, not one the fence can name.
      if (object.temporary) return undefined
      kind = object.kind
      at = object.next
      if (word(tokens, at) === "IF" && word(tokens, at + 1) === "NOT" && word(tokens, at + 2) === "EXISTS") at += 3
      break
    }
    case "CALL": {
      kind = "routine"
      break
    }
    case "GRANT":
    case "REVOKE": {
      // GRANT … ON [TABLE|VIEW|SCHEMA] <path>; a project is not a dataset object.
      while (at < tokens.length && word(tokens, at) !== "ON") at += 1
      if (word(tokens, at) !== "ON") return undefined
      at += 1
      const object = objectWords(tokens, at)
      if (object !== undefined) {
        kind = object.kind
        at = object.next
        if (object.temporary) return undefined
      }
      break
    }
    default:
      return undefined
  }
  const parts = path(tokens, at)
  if (parts === undefined) return undefined
  return targetOf(parts, kind, project)
}

interface ObjectWords {
  readonly kind: PlanTarget["kind"]
  readonly next: number
  readonly temporary: boolean
}

function objectWords(tokens: readonly Token[], at: number): ObjectWords | undefined {
  let temporary = false
  let index = at
  if (word(tokens, index) === "TEMP" || word(tokens, index) === "TEMPORARY") {
    temporary = true
    index += 1
  }
  if (word(tokens, index) === "OR" && word(tokens, index + 1) === "REPLACE") index += 2
  if (word(tokens, index) === "EXTERNAL") index += 1
  if (word(tokens, index) === "SNAPSHOT") index += 1
  if (word(tokens, index) === "MATERIALIZED") index += 1
  const object = word(tokens, index)
  if (object === undefined) return undefined
  if (object === "SCHEMA") return { kind: "dataset", next: index + 1, temporary }
  if (object === "VIEW") return { kind: "view", next: index + 1, temporary }
  if (object === "FUNCTION" || object === "PROCEDURE") return { kind: "routine", next: index + 1, temporary }
  if (object === "TABLE" && word(tokens, index + 1) === "FUNCTION") return { kind: "routine", next: index + 2, temporary }
  if (OBJECT_WORDS.has(object)) return { kind: "table", next: index + 1, temporary }
  return undefined
}

function word(tokens: readonly Token[], at: number): string | undefined {
  const token = tokens[at]
  return token !== undefined && (token.kind === "keyword" || token.kind === "identifier") ? token.value.toUpperCase() : undefined
}

/** The dotted path after `at`: a quoted token's parts, or identifier/keyword parts separated by `.`. */
function path(tokens: readonly Token[], at: number): string[] | undefined {
  const first = tokens[at]
  if (first === undefined) return undefined
  if (first.kind === "quoted") {
    const parts = [...(first.parts ?? [])]
    return clean(parts)
  }
  const parts: string[] = []
  let index = at
  for (;;) {
    const token = tokens[index]
    if (token === undefined || (token.kind !== "keyword" && token.kind !== "identifier")) break
    parts.push(token.text)
    const dot = tokens[index + 1]
    if (dot === undefined || !((dot.kind === "operator" || dot.kind === "punctuation") && dot.text === ".")) break
    index += 2
  }
  return clean(parts)
}

/** A path's parts, with a partition decorator dropped, or undefined when it is not a dataset object. */
function clean(parts: readonly string[]): string[] | undefined {
  if (parts.length === 0 || parts.length > 3) return undefined
  const out = parts.map((part) => part.split("$")[0] ?? part)
  if (out.some((part) => part.length === 0 || part === "_SESSION" || part === "SESSION" || part.includes("*") || !SAFE_PART.test(part))) return undefined
  return out
}

function targetOf(parts: readonly string[], kind: PlanTarget["kind"], project: string): Target | undefined {
  if (kind === "dataset") {
    // A schema path is [project.]dataset; three parts are not a dataset.
    if (parts.length === 1) return { kind, project, dataset: parts[0]!, name: parts[0]!, label: label([project, parts[0]!]), source: "statement" }
    if (parts.length === 2) return { kind, project: parts[0]!, dataset: parts[1]!, name: parts[1]!, label: label([parts[0]!, parts[1]!]), source: "statement" }
    return undefined
  }
  if (parts.length === 1) {
    // A one-part table name needs a default dataset the plan does not carry; the fence cannot name it.
    return undefined
  }
  const owner = parts.length === 3 ? parts[0]! : project
  const dataset = parts.length === 3 ? parts[1]! : parts[0]!
  const name = parts.length === 3 ? parts[2]! : parts[1]!
  return { kind, project: owner, dataset, name, label: label([owner, dataset, name]), source: "statement" }
}
