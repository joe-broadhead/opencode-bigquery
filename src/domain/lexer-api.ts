/**
 * The lexer's API and token types (design §5.5). Day 0 fixes the shape; package C builds the lexer
 * (`src/guards/lexer.ts`) to it. The lexer only ever raises a decision: it never makes a statement a read that
 * BigQuery's dry run did not call one, and its category findings pass through `raise` (src/domain/statements.ts).
 */
import type { Kind } from "./statements.js"

export type TokenKind =
  | "keyword"
  | "identifier"
  /** A backquoted path, split on dots into `parts`. */
  | "quoted"
  /** `'…'`, `"…"`, triple-quoted, raw (`r'…'`) and bytes (`b'…'`) strings. */
  | "string"
  | "number"
  | "operator"
  | "punctuation"
  /** `@name` and `?` parameters. */
  | "parameter"
  /** `--`, `#` and `/* … *\/` comments: kept as tokens, so a hint is found and nothing hides between path parts. */
  | "comment"

export interface Token {
  readonly kind: TokenKind
  /** The source text, exactly. */
  readonly text: string
  /** Upper-cased for keywords and identifiers; the unquoted parts for `quoted`. */
  readonly value: string
  readonly parts?: readonly string[]
  /** 1-based line and column of the first character. */
  readonly line: number
  readonly column: number
}

/** A failed lex: an unterminated string, comment or backquote. Refused as `SQL_INVALID`. */
export interface LexError {
  readonly line: number
  readonly column: number
  readonly what: "unterminated-string" | "unterminated-comment" | "unterminated-identifier" | "invalid-character"
}

export type LexResult = { readonly ok: true; readonly tokens: readonly Token[] } | { readonly ok: false; readonly error: LexError }

/** What the lexer finds in one text: a top-level statement, or an expanded view or routine body. */
export interface Findings {
  /** The kind the text's own wording requires, at least (§5.2, M4): `delete` for `DELETE` in `MERGE`, `DROP` in `ALTER`, `OR REPLACE`, expiration options in `SET OPTIONS`, `LOAD DATA OVERWRITE`; `write` for external effects. */
  readonly raisesTo?: Kind
  /** Calls billed or acting outside BigQuery: `EXTERNAL_QUERY`, any `ML.*` or `AI.*` (with `SAFE.` too), `OBJ.GET_ACCESS_URL`. */
  readonly externalEffects: readonly string[]
  /** `#legacySQL` or `#standardSQL` hints. */
  readonly dialectHint?: "legacy" | "standard"
  /** Column names the text names, compared case-insensitively, backquoted or not (`t.`SSN`` matches `ssn`). */
  readonly columnNames: ReadonlySet<string>
  /** `*` or `t.*` anywhere. */
  readonly usesStar: boolean
  /** A table alias used as a value: `SELECT t`, `TO_JSON(t)`, `ARRAY_AGG(t)`, `(SELECT AS STRUCT t.*)`. */
  readonly aliasAsValue: boolean
}

export interface Lexer {
  lex(sql: string): LexResult
  /** The findings for one lexed text. */
  findings(tokens: readonly Token[]): Findings
}
