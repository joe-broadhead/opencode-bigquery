/**
 * The lexer (design §5.5), built to the Day 0 API in `src/domain/lexer-api.ts`.
 *
 * It tokenises GoogleSQL so the guards can look inside a statement without trusting it: comments, all four string
 * forms, backquoted paths, parameters and the punctuation that carries meaning. It then reports findings, and it only
 * ever **raises** a decision (`raise` in `src/domain/statements.ts`): a text it cannot read refuses (`SQL_INVALID`), a
 * finding makes a statement stricter, and nothing it reports can make a statement a read that BigQuery's dry run did
 * not call one.
 *
 * What it must catch, from §5.5 and review M4:
 * - `DELETE` in `MERGE`, `DROP` in `ALTER`, `OR REPLACE`, the four expiry options in `SET OPTIONS`, and `LOAD DATA
 *   OVERWRITE` are destructive: `delete`.
 * - calls that act or bill outside BigQuery — `EXTERNAL_QUERY`, any `ML.*` / `AI.*` call (with a `SAFE.` prefix too),
 *   `OBJ.GET_ACCESS_URL` — are external effects: `write`.
 * - a routine call (`CALL`) or `EXECUTE IMMEDIATE`, which runs text the plugin never saw, except inside a
 *   `CREATE PROCEDURE`/`FUNCTION` body, where they are only stored, and transactions, which are `delete`.
 * - whether a text uses `*` and which names it uses, for the hints.
 * - a temporary function's definition, whose body no server list is documented to cover, so the read path refuses it.
 *
 * It does **not** find the tables a statement reads. BigQuery's own dry run does (`referencedTables`,
 * `referencedLogicalViews`, `referencedRoutines`), so no alias, join or comma form can hide one from the guards; the
 * lexer's only part in that is the `INFORMATION_SCHEMA` views an allow fence cannot confine.
 *
 * It deliberately does **not** count statements or decide DDL/DML: BigQuery's own `statementType` is the parse of the
 * exact text that runs (design D5), so a script, a `CALL` or an `EXECUTE IMMEDIATE` is refused by that type. The
 * lexer only adds the findings a statement type cannot express. Whitespace is dropped; comments are kept as tokens, so
 * nothing hides between the parts of a dotted name and a `#legacySQL` hint is found.
 */

import type { Findings, LexError, Lexer, LexResult, Token, TokenKind } from "../domain/lexer-api.js"
import type { Kind } from "../domain/statements.js"
import { stricter } from "../domain/statements.js"

/** Words a statement can be written with. Used only to label tokens; every finding reads `value` either way. */
const KEYWORDS: ReadonlySet<string> = new Set(
  (
    "ALL ALTER AND ANY ARRAY AS ASC ASSERT AT BEGIN BETWEEN BIGNUMERIC BIGINT BOOL BOOLEAN BY BYTES CALL CASE CAST " +
    "CLUSTER COLLATE COLUMN COMMIT CONNECTION CONSTANT CREATE CROSS CUBE CURRENT DATA DATE DATETIME DECLARE DEFAULT " +
    "DEFINE DELETE DESC DESCRIBE DISTINCT DO DOUBLE DROP ELSE END ENUM EXCEPT EXECUTE EXISTS EXPLAIN EXPORT EXTENSION " +
    "EXTERNAL EXTRACT FALSE FETCH FOLLOWING FOR FORMAT FROM FULL FUNCTION GEOGRAPHY GRANT GROUP GROUPING GROUPS HASH " +
    "HAVING IF IGNORE IMMEDIATE IN INDEX INNER INSERT INT INT64 INTEGER INTERSECT INTERVAL INTO IS JOIN JSON KEY " +
    "LANGUAGE LATERAL LEFT LIKE LIMIT LOAD MATERIALIZED MERGE MODEL NEW NO NOT NULL NUMERIC OFFSET ON OPTIONS OR " +
    "ORDER OUTER OVER OVERWRITE PARTITION PARTITIONS PRECEDING PROCEDURE PROJECTION QUALIFY RANGE RECURSIVE REPLACE " +
    "RESTRICT RETURNS REVOKE RIGHT ROLLBACK ROW ROWS SAFE SCHEMA SELECT SET SMALLINT SNAPSHOT SOME STRUCT SYSTEM " +
    "TABLE TABLESAMPLE TEMP TEMPORARY THEN TIME TIMESTAMP TO TRANSACTION TRUE TRUNCATE UNBOUNDED UNION UNIQUE " +
    "UNKNOWN UNNEST UNTIL UPDATE USING VALUE VALUES VIEW WINDOW WITH WITHIN"
  ).split(" "),
)

/** The `SET OPTIONS` settings that destroy data by making it expire (review M4). */
const EXPIRY_OPTIONS: ReadonlySet<string> = new Set([
  "EXPIRATION_TIMESTAMP",
  "PARTITION_EXPIRATION_DAYS",
  "DEFAULT_TABLE_EXPIRATION_DAYS",
  "DEFAULT_PARTITION_EXPIRATION_DAYS",
])

/** The longest prefix of a GoogleSQL string literal, then its quote. */
function stringStart(sql: string, at: number): { readonly length: number; readonly quote: string; readonly raw: boolean } | undefined {
  const first = sql[at]
  if (first === "'" || first === '"') return { length: 0, quote: first, raw: false }
  if (first === undefined) return undefined
  const lower = first.toLowerCase()
  if (lower !== "r" && lower !== "b") return undefined
  const second = sql[at + 1]
  if (second === "'" || second === '"') return { length: 1, quote: second, raw: lower === "r" }
  const third = sql[at + 2]
  if (third === "'" || third === '"') {
    const two = `${lower}${second?.toLowerCase() ?? ""}`
    if (two === "rb" || two === "br") return { length: 2, quote: third, raw: true }
  }
  return undefined
}

const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v"
const isDigit = (ch: string) => ch >= "0" && ch <= "9"
const isLetter = (ch: string) => (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_"
const isIdent = (ch: string) => isLetter(ch) || isDigit(ch) || ch === "$"

/** The multi-character operators, longest first, so `<=` is never read as `<` then `=`. */
const OPERATORS = ["<<=", ">>=", "<=>", "=>", "->", "<=", ">=", "!=", "<>", "||", "&&", "<<", ">>", "|", "&", "^", "~", "=", "<", ">", "+", "-", "*", "/", "%", ":", "@"]
const PUNCTUATION = "()[]{},;."

class LexFailure extends Error {
  constructor(readonly error: LexError) {
    super(error.what)
  }
}

/** One lexer: stateless; every call takes a text. */
export function createLexer(): Lexer {
  return { lex: lexText, findings }
}

export function lexText(sql: string): LexResult {
  try {
    return { ok: true, tokens: scan(sql) }
  } catch (error) {
    if (error instanceof LexFailure) return { ok: false, error: error.error }
    throw error
  }
}

function scan(sql: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  let line = 1
  let column = 1
  const advance = (count = 1) => {
    for (let step = 0; step < count; step += 1) {
      if (sql[at] === "\n") {
        line += 1
        column = 1
      } else column += 1
      at += 1
    }
  }
  const push = (kind: TokenKind, start: number, startLine: number, startColumn: number, value?: string, parts?: readonly string[]) => {
    const text = sql.slice(start, at)
    tokens.push({ kind, text, value: value ?? text, line: startLine, column: startColumn, ...(parts ? { parts } : {}) })
  }
  const fail = (what: LexError["what"], errorLine: number, errorColumn: number): never => {
    throw new LexFailure({ line: errorLine, column: errorColumn, what })
  }

  while (at < sql.length) {
    const ch = sql[at]!
    if (isSpace(ch)) {
      advance()
      continue
    }
    const startLine = line
    const startColumn = column
    const start = at

    // ── comments ───────────────────────────────────────────────────────
    if (ch === "-" && sql[at + 1] === "-") {
      while (at < sql.length && sql[at] !== "\n") advance()
      push("comment", start, startLine, startColumn)
      continue
    }
    if (ch === "#") {
      while (at < sql.length && sql[at] !== "\n") advance()
      push("comment", start, startLine, startColumn)
      continue
    }
    if (ch === "/" && sql[at + 1] === "*") {
      advance(2)
      let closed = false
      while (at < sql.length) {
        if (sql[at] === "*" && sql[at + 1] === "/") {
          advance(2)
          closed = true
          break
        }
        advance()
      }
      if (!closed) fail("unterminated-comment", startLine, startColumn)
      push("comment", start, startLine, startColumn)
      continue
    }

    // ── strings: '…', "…", '''…''', r'…', b'…', rb'…' ──────────────────
    const string = stringStart(sql, at)
    if (string) {
      advance(string.length)
      const quote = sql[at]!
      const triple = sql[at + 1] === quote && sql[at + 2] === quote
      advance(triple ? 3 : 1)
      let closed = false
      while (at < sql.length) {
        const current = sql[at]!
        if (current === "\\" && !string.raw) {
          // An escape hides the next character, quote or not.
          advance(2)
          continue
        }
        if (current === quote) {
          if (!triple) {
            advance()
            closed = true
            break
          }
          if (sql[at + 1] === quote && sql[at + 2] === quote) {
            advance(3)
            closed = true
            break
          }
        }
        advance()
      }
      if (!closed) fail("unterminated-string", startLine, startColumn)
      push("string", start, startLine, startColumn)
      continue
    }

    // ── backquoted paths, split on dots ────────────────────────────────
    if (ch === "`") {
      advance()
      const parts: string[] = [""]
      let closed = false
      while (at < sql.length) {
        const current = sql[at]!
        if (current === "\\") {
          const next = sql[at + 1]
          if (next === undefined) break
          parts[parts.length - 1] += next
          advance(2)
          continue
        }
        if (current === "`") {
          advance()
          closed = true
          break
        }
        if (current === ".") {
          parts.push("")
          advance()
          continue
        }
        parts[parts.length - 1] += current
        advance()
      }
      if (!closed) fail("unterminated-identifier", startLine, startColumn)
      push("quoted", start, startLine, startColumn, parts.join("."), parts)
      continue
    }

    // ── parameters: @name, @@name, ? ───────────────────────────────────
    if (ch === "@" && sql[at + 1] === "@" && isIdent(sql[at + 2] ?? "")) {
      advance(3)
      while (at < sql.length && isIdent(sql[at]!)) advance()
      push("parameter", start, startLine, startColumn)
      continue
    }
    if (ch === "@" && isIdent(sql[at + 1] ?? "")) {
      advance(2)
      while (at < sql.length && isIdent(sql[at]!)) advance()
      push("parameter", start, startLine, startColumn)
      continue
    }
    if (ch === "?" ) {
      advance()
      push("parameter", start, startLine, startColumn)
      continue
    }

    // ── numbers ────────────────────────────────────────────────────────
    if (isDigit(ch) || (ch === "." && isDigit(sql[at + 1] ?? ""))) {
      if (ch === "0" && (sql[at + 1] === "x" || sql[at + 1] === "X")) {
        advance(2)
        while (at < sql.length && /[0-9a-fA-F]/.test(sql[at]!)) advance()
      } else {
        while (at < sql.length && isDigit(sql[at]!)) advance()
        if (sql[at] === "." && isDigit(sql[at + 1] ?? "")) {
          advance()
          while (at < sql.length && isDigit(sql[at]!)) advance()
        }
        if (sql[at] === "e" || sql[at] === "E") {
          const sign = sql[at + 1] === "+" || sql[at + 1] === "-" ? 1 : 0
          if (isDigit(sql[at + 1 + sign] ?? "")) {
            advance(1 + sign)
            while (at < sql.length && isDigit(sql[at]!)) advance()
          }
        }
      }
      push("number", start, startLine, startColumn)
      continue
    }

    // ── bare words: keywords and identifiers ───────────────────────────
    if (isLetter(ch)) {
      advance()
      while (at < sql.length && isIdent(sql[at]!)) advance()
      const text = sql.slice(start, at)
      const upper = text.toUpperCase()
      push(KEYWORDS.has(upper) ? "keyword" : "identifier", start, startLine, startColumn, upper)
      continue
    }

    // ── punctuation, then operators ────────────────────────────────────
    if (PUNCTUATION.includes(ch)) {
      advance()
      push("punctuation", start, startLine, startColumn)
      continue
    }
    const operator = OPERATORS.find((candidate) => sql.startsWith(candidate, at))
    if (operator) {
      advance(operator.length)
      push("operator", start, startLine, startColumn)
      continue
    }
    fail("invalid-character", startLine, startColumn)
  }
  return tokens
}

/** The tokens that carry meaning: comments and nothing else are dropped for every finding. */
export function significantTokens(tokens: readonly Token[]): Token[] {
  return tokens.filter((token) => token.kind !== "comment")
}

const isWord = (token: Token | undefined) => token !== undefined && (token.kind === "keyword" || token.kind === "identifier")
const isPunct = (token: Token | undefined, text: string) => token !== undefined && (token.kind === "punctuation" || token.kind === "operator") && token.text === text

/** The findings for one lexed text (design §5.5, §5.3). */
export function findings(tokens: readonly Token[]): Findings {
  const all = significantTokens(tokens)
  const raised: Kind[] = []
  const raise = (kind: Kind) => void raised.push(kind)
  const effects: string[] = []

  // A `#legacySQL` hint anywhere wins: the read path refuses legacy SQL, whatever else the text says.
  let dialectHint: Findings["dialectHint"]
  for (const token of tokens) {
    if (token.kind !== "comment" || !token.text.startsWith("#")) continue
    const hint = /^#[ \t]*([A-Za-z]+)/.exec(token.text)?.[1]?.toLowerCase()
    if (hint === "legacysql") dialectHint = "legacy"
    else if (hint === "standardsql" && dialectHint === undefined) dialectHint = "standard"
  }

  // ── calls that act or bill outside BigQuery ──────────────────────────
  for (const chain of chains(all)) {
    if (!chain.called) continue
    const parts = chain.parts.map((part) => part.toUpperCase())
    const [first, second] = parts
    if (parts.length === 1 && first === "EXTERNAL_QUERY") effects.push("EXTERNAL_QUERY")
    else if (parts.length >= 2 && parts.at(-2) === "OBJ" && parts.at(-1) === "GET_ACCESS_URL") effects.push("OBJ.GET_ACCESS_URL")
    else if (first === "ML" || first === "AI") effects.push(parts.join("."))
    else if (first === "SAFE" && (second === "ML" || second === "AI")) effects.push(parts.join("."))
  }

  // ── destructive wording (review M4) and calls that run hidden text ──
  // A text that defines a routine stores its body; the body's CALL, EXECUTE IMMEDIATE and BEGIN/END are not run, so
  // they are not raised. Everywhere else they run text the plugin never read, so they are delete.
  const words = new Set(all.filter(isWord).map((token) => token.value.toUpperCase()))
  const definesRoutine = words.has("CREATE") && (words.has("PROCEDURE") || words.has("FUNCTION"))
  for (const segment of segments(all)) {
    const has = (word: string) => segment.some((token) => isWord(token) && token.value.toUpperCase() === word)
    if (has("MERGE") && has("DELETE")) raise("delete")
    if (has("ALTER") && has("DROP")) raise("delete")
    for (let index = 0; index + 1 < segment.length; index += 1) {
      const token = segment[index]!
      const next = segment[index + 1]!
      if (token.value.toUpperCase() === "OR" && next.value.toUpperCase() === "REPLACE") raise("delete")
    }
    // `SET OPTIONS (expiration_timestamp = …)` and its siblings destroy data by expiry.
    const setAt = segment.findIndex((token) => isWord(token) && token.value.toUpperCase() === "SET")
    if (setAt >= 0 && segment.slice(setAt + 1).some((token) => isWord(token) && token.value.toUpperCase() === "OPTIONS")) {
      if (segment.some((token) => isWord(token) && EXPIRY_OPTIONS.has(token.value.toUpperCase()))) raise("delete")
    }
    // `LOAD DATA … OVERWRITE` replaces a table rather than appending to it.
    const loadAt = segment.findIndex((token) => isWord(token) && token.value.toUpperCase() === "LOAD")
    if (loadAt >= 0 && segment.slice(loadAt + 1).some((token) => isWord(token) && token.value.toUpperCase() === "DATA")) {
      if (segment.slice(loadAt + 1).some((token) => isWord(token) && token.value.toUpperCase() === "OVERWRITE")) raise("delete")
    }
    if (!definesRoutine) {
      if (has("CALL")) raise("delete")
      if (has("EXECUTE") && has("IMMEDIATE")) raise("delete")
      if (has("BEGIN") || has("COMMIT") || has("ROLLBACK")) raise("delete")
    }
  }

  if (effects.length > 0) raise("write")

  // ── the names a text uses, for the hints ────────────────────────────
  const columnNames = new Set<string>()
  for (const token of all) {
    if (token.kind === "keyword" || token.kind === "identifier") columnNames.add(token.value.toUpperCase())
    if (token.kind === "quoted") for (const part of token.parts ?? []) columnNames.add(part.toUpperCase())
  }

  return {
    ...(raised.length > 0 ? { raisesTo: raised.reduce<Kind>((highest, kind) => stricter(highest, kind), "read") } : {}),
    externalEffects: [...new Set(effects)],
    ...(dialectHint ? { dialectHint } : {}),
    columnNames,
    usesStar: usesStar(all),
    // Not computed. The policy-tag rule is decided from the tables BigQuery's dry run names (src/guards/policy.ts), not
    // from aliases in the text, and nothing reads this field; contract request 8 removes it from Day 0's Findings.
    aliasAsValue: false,
  }
}

/** A token's name parts exactly as written: an object's name, which is not case-folded. */
function tokenNames(token: Token): string[] {
  if (token.kind === "quoted") return [...(token.parts ?? [token.value])]
  return [token.text]
}

/** The statement segments: significant tokens split on `;`. */
function segments(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = []
  let current: Token[] = []
  for (const token of tokens) {
    if (isPunct(token, ";")) {
      if (current.length > 0) out.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * `*` as a wildcard: a star that is not certainly multiplication. `SELECT *`, `t.*` and `COUNT(*)` all count (the last
 * is conservative: it reads no column, but a table with tagged columns still goes to a save); `a * b` does not.
 */
function usesStar(tokens: readonly Token[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!isPunct(token, "*")) continue
    const before = tokens[index - 1]
    const after = tokens[index + 1]
    const valueBefore = before !== undefined && (before.kind === "identifier" || before.kind === "quoted" || before.kind === "number" || before.kind === "parameter" || isPunct(before, ")"))
    const valueAfter = after !== undefined && (after.kind === "identifier" || after.kind === "quoted" || after.kind === "number" || after.kind === "parameter" || isPunct(after, "("))
    if (valueBefore && valueAfter) continue
    return true
  }
  return false
}

/** One dotted name in the stream: its parts, where it ends, and whether a `(` follows it. */
interface Chain {
  readonly parts: readonly string[]
  readonly end: number
  readonly called: boolean
}

/** Every dotted name, including one split over backquotes, bare words, comments and whitespace (`ml` /* x *\/ . `f`). */
function chains(tokens: readonly Token[]): Chain[] {
  const out: Chain[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!isWord(token) && token.kind !== "quoted") continue
    const parts = [...tokenNames(token)]
    let end = index
    while (isPunct(tokens[end + 1], ".") && (isWord(tokens[end + 2]) || tokens[end + 2]?.kind === "quoted")) {
      parts.push(...tokenNames(tokens[end + 2]!))
      end += 2
    }
    out.push({ parts, end, called: isPunct(tokens[end + 1], "(") })
    index = end
  }
  return out
}

/** An INFORMATION_SCHEMA view the lexer saw: dataset-qualified, or project/region-qualified and unconfined by a fence. */
export interface InformationSchemaRef {
  readonly level: "region" | "project" | "dataset"
  readonly parts: readonly string[]
}

/**
 * Every `INFORMATION_SCHEMA` view a text names, as a dotted chain (review round 1, LOW 1): project- or region-qualified
 * (`region-us.INFORMATION_SCHEMA.JOBS`) or dataset-qualified (`p.d.INFORMATION_SCHEMA.TABLES`). Google's Job resource
 * does not say whether a dry run lists these in `referencedTables`, so an allow fence checks them from the text.
 */
export function informationSchemaRefs(tokens: readonly Token[]): InformationSchemaRef[] {
  const out: InformationSchemaRef[] = []
  const seen = new Set<string>()
  for (const chain of chains(significantTokens(tokens))) {
    const at = chain.parts.findIndex((part) => part.toUpperCase() === "INFORMATION_SCHEMA")
    if (at < 0) continue
    const key = chain.parts.join(".")
    if (seen.has(key)) continue
    seen.add(key)
    if (at === 1) out.push({ level: /^REGION-/i.test(chain.parts[0] ?? "") ? "region" : "project", parts: [...chain.parts] })
    else if (at === 2) out.push({ level: "dataset", parts: [...chain.parts] })
    // Nothing before it (the default dataset's or project's own views) or more than two parts: fail closed, as wide as a
    // project.
    else out.push({ level: "project", parts: [...chain.parts] })
  }
  return out
}

/** The words that may sit between `CREATE` and `FUNCTION` in a temporary function's definition. */
const FUNCTION_PREFIX: ReadonlySet<string> = new Set(["OR", "REPLACE", "TEMP", "TEMPORARY", "TABLE", "AGGREGATE", "IF", "NOT", "EXISTS"])

/**
 * Whether a text defines a function (`CREATE [OR REPLACE] TEMP [TABLE|AGGREGATE] FUNCTION …`). On the read path that is
 * a temporary function: it is not a persisted routine, `routines.get` cannot read it, and Google's Job resource does not
 * say that `referencedTables` or `referencedRoutines` cover what its body reads, so the read path refuses it rather than
 * parse the body.
 */
export function definesFunction(tokens: readonly Token[]): boolean {
  const all = significantTokens(tokens)
  for (let index = 0; index < all.length; index += 1) {
    if (!isWord(all[index]) || all[index]!.value.toUpperCase() !== "CREATE") continue
    for (let next = index + 1; next < all.length; next += 1) {
      const token = all[next]!
      if (!isWord(token)) break
      const word = token.value.toUpperCase()
      if (word === "FUNCTION") return true
      if (!FUNCTION_PREFIX.has(word)) break
    }
  }
  return false
}

/** Whether a keyword appears in a token stream, for the hints (a `LIMIT` over a full scan). */
export function hasKeyword(tokens: readonly Token[], word: string): boolean {
  const upper = word.toUpperCase()
  return tokens.some((token) => token.kind === "keyword" && token.value.toUpperCase() === upper)
}
