/**
 * BigQuery's typed JSON as values (design §7). REST answers carry a row as `{ "f": [ { "v": … }, … ] }`: every scalar
 * arrives as text, a STRUCT as `{ "f": … }` and a REPEATED field as an array of `{ "v": … }`
 * (https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/list, `rows[]`, "a series of JSON f,v objects").
 *
 * The conversion keeps what the model and a saved file need:
 * - INT64 becomes a number only inside ±(2^53−1); outside it, the exact decimal text stays a string;
 * - NUMERIC and BIGNUMERIC stay strings (they carry more digits than a double);
 * - FLOAT64 becomes a number, but `NaN`, `Infinity` and `-Infinity` stay the strings Google sent;
 * - TIMESTAMP becomes ISO 8601 UTC with Google's microseconds kept (`…T12:00:00.123456Z`);
 * - DATE, TIME, DATETIME, JSON, BYTES (base64), GEOGRAPHY (WKT) and INTERVAL stay their text;
 * - RANGE becomes `{ start, end }`, each bound Google's literal text, because BigQuery's range types are DATE, DATETIME
 *   and TIMESTAMP (https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types#range_type);
 * - STRUCT becomes an object keyed by its fields' names, and ARRAY/REPEATED an array, however deeply nested.
 *
 * Inline cells are shaped for a model (design §7): a string, ARRAY, STRUCT or JSON cell is cut to 200 characters (an
 * ARRAY or STRUCT as its JSON text), BYTES to 64, and control characters other than tab and newline are escaped
 * (design §5.6). Numbers and booleans are unchanged, and null stays null.
 */
import type { SchemaField } from "../domain/google.js"

/** Columns as the contract shows them: the fields' names and types, in order. */
export function columns(fields: readonly SchemaField[]): { name: string; type: string }[] {
  return fields.map((field) => ({ name: field.name, type: field.type }))
}

/** One page's `f`/`v` rows as arrays of values, in the schema's order. */
export function convertRows(fields: readonly SchemaField[], rows: readonly unknown[]): unknown[][] {
  return rows.map((row) => convertRow(fields, row))
}

/** One row (`{ f: […] }`) as an array. A short row is padded with nulls, never with a shifted value. */
export function convertRow(fields: readonly SchemaField[], row: unknown): unknown[] {
  const cells = isRecord(row) && Array.isArray(row.f) ? row.f : []
  return fields.map((field, index) => convertValue(field, valueOf(cells[index])))
}

/** One cell's value, by its field and its mode. */
export function convertValue(field: SchemaField, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (field.mode === "REPEATED") {
    const items = Array.isArray(value) ? value : [value]
    return items.map((item) => convertValue({ ...field, mode: "NULLABLE" }, valueOf(item)))
  }
  switch (baseType(field.type)) {
    case "INT64":
      return int64(text(value))
    case "FLOAT64":
      return float64(text(value))
    case "NUMERIC":
    case "BIGNUMERIC":
      return text(value) ?? null
    case "BOOL":
      return value === true || value === "true" || value === "TRUE"
    case "TIMESTAMP":
      return timestamp(text(value))
    case "STRUCT": {
      const nested = isRecord(value) && Array.isArray(value.f) ? value.f : []
      const out: Record<string, unknown> = {}
      for (const [index, child] of (field.fields ?? []).entries()) out[child.name] = convertValue(child, valueOf(nested[index]))
      return out
    }
    case "RANGE":
      return range(text(value))
    case "INTERVAL":
      return text(value) ?? null
    default:
      // STRING, BYTES (base64), DATE, TIME, DATETIME, JSON (its text), GEOGRAPHY (WKT) and any type this version does
      // not know: Google's text as it arrived.
      return value
  }
}

/** A cell as `{ v }`, or the bare value. */
export function valueOf(cell: unknown): unknown {
  return isRecord(cell) && "v" in cell ? cell.v : cell
}

/** The contract's inline caps (design §7): a cell at 200 characters, a BYTES cell at 64. */
export const CELL_CHARS = 200
export const BYTES_CHARS = 64

/** One value as the model reads it: cut, with control characters escaped. */
export function inlineCell(field: SchemaField | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return clip(escapeControls(value), baseType(field?.type) === "BYTES" ? BYTES_CHARS : CELL_CHARS)
  const json = JSON.stringify(value)
  return json === undefined ? null : clip(escapeControls(json), CELL_CHARS)
}

export interface InlineOptions {
  /** Rows the model may see; the first one over proves there are more. */
  readonly maxRows: number
  /** Bytes of inline JSON across the rows; 32 KiB by default, 256 KiB at most (design §7). */
  readonly maxInlineBytes: number
}

export interface InlineRows {
  readonly rows: unknown[][]
  readonly truncated: { readonly rows: boolean; readonly cells: boolean; readonly bytes: boolean }
}

/** Rows shaped for a model, within both caps, with exactly what was cut. */
export function inlineRows(fields: readonly SchemaField[], rows: readonly unknown[][], options: InlineOptions): InlineRows {
  const kept: unknown[][] = []
  let cells = false
  let used = 0
  for (const row of rows) {
    if (kept.length >= options.maxRows) return { rows: kept, truncated: { rows: true, cells, bytes: false } }
    const shaped = row.map((value, index) => {
      const field = fields[index]
      const cell = inlineCell(field, value)
      if (isCut(field, value, cell)) cells = true
      return cell
    })
    const size = Buffer.byteLength(JSON.stringify(shaped), "utf8")
    // A row is atomic: one that alone exceeds the byte budget is dropped, not cut in half.
    if (used + size > options.maxInlineBytes) return { rows: kept, truncated: { rows: true, cells, bytes: true } }
    used += size
    kept.push(shaped)
  }
  return { rows: kept, truncated: { rows: rows.length > kept.length, cells, bytes: false } }
}

/** Whether a shaped cell differs from its value because of a cap. */
function isCut(field: SchemaField | undefined, value: unknown, cell: unknown): boolean {
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return false
  if (typeof value === "string") return cell !== value
  return typeof cell === "string" && cell.length >= CELL_CHARS && cell.endsWith("…")
}

/** Google's type names, old and new: the API answers INTEGER/FLOAT/RECORD on older tables. */
export function baseType(type: string | undefined): string {
  const upper = (type ?? "").toUpperCase()
  switch (upper) {
    case "INTEGER":
      return "INT64"
    case "FLOAT":
      return "FLOAT64"
    case "BOOLEAN":
      return "BOOL"
    case "RECORD":
      return "STRUCT"
    default:
      return upper
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

/** An INT64 as a number when it is exactly representable, else its decimal text. */
function int64(value: string | undefined): number | string | null {
  if (value === undefined) return null
  if (!/^[-+]?\d+$/.test(value)) return value
  const big = BigInt(value)
  return big <= MAX_SAFE && big >= MIN_SAFE ? Number(big) : value
}

/** A FLOAT64 as a number; Google's `NaN`, `Infinity` and `-Infinity` stay strings (design §7). */
function float64(value: string | undefined): number | string | null {
  if (value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

/**
 * Google's seconds since the epoch (a double, in text) as ISO 8601 UTC. Its microseconds are kept when it sent any:
 * `2026-11-17T12:00:00.123456Z`.
 */
function timestamp(value: string | undefined): string | null {
  if (value === undefined) return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return value
  // Split before multiplying: seconds × 1e6 passes 2^53 for any modern timestamp, and would lose the microseconds.
  const whole = Math.floor(seconds)
  let micros = Math.round((seconds - whole) * 1e6)
  let millis = whole * 1000
  if (micros >= 1e6) {
    millis += 1000
    micros = 0
  }
  const iso = new Date(millis).toISOString()
  if (micros === 0) return iso
  // Replace ISO's milliseconds with Google's microseconds: six digits, trailing zeros dropped.
  return `${iso.slice(0, 19)}.${String(micros).padStart(6, "0").replace(/0+$/, "")}Z`
}

/** `[2026-01-01, 2026-12-31)` as `{ start, end }`; `UNBOUNDED` becomes null. */
function range(value: string | undefined): { start: string | null; end: string | null } | null {
  if (value === undefined) return null
  const match = /^[[(](.+), (.+)[)\]]$/.exec(value)
  if (!match) return { start: value, end: null }
  const bound = (part: string) => (part === "UNBOUNDED" || part === "NULL" ? null : part)
  return { start: bound(match[1]!), end: bound(match[2]!) }
}

/** Cuts to `length` characters, the last one an ellipsis when anything was dropped. */
function clip(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

/** Control characters other than tab and newline, escaped as JSON would (design §5.6). */
function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}
