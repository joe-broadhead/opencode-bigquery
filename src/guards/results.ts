/**
 * Results for a model (design §7): rows as arrays in `columns` order, every cell cut, nested values cut as their JSON
 * text, control characters escaped, and the inline byte cap enforced while shaping rather than after it. A page is
 * fetched with `maxResults = maxRows + 1`, so `truncated.rows` is exact.
 *
 * A port may hand rows in Google's own `{ f: [{ v }] }` form or already converted (package B owns value conversion);
 * both are accepted. Types come from the page's schema, and a value that does not fit its type is shown as text rather
 * than guessed at.
 */
import type { SchemaField } from "../domain/google.js"

export interface ResultColumn {
  readonly name: string
  readonly type: string
}

export interface ShapedRows {
  readonly columns: readonly ResultColumn[]
  readonly rows: readonly (readonly unknown[])[]
  readonly returned: number
  readonly truncated: { readonly rows: boolean; readonly cells: boolean; readonly bytes: boolean }
}

const CELL = 200
const BYTES_CELL = 64

/** Control characters other than tab and newline, escaped (§5.6). */
export function sanitise(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

const cutText = (text: string, max = CELL): { value: string; cut: boolean } => {
  const clean = sanitise(text)
  return clean.length > max ? { value: `${clean.slice(0, max - 1)}…`, cut: true } : { value: clean, cut: false }
}

const isSafeInteger = (value: number) => Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER

/** A TIMESTAMP arrives as seconds since the epoch, possibly fractional, and leaves as ISO UTC. */
function timestamp(value: unknown): unknown {
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined
  if (seconds === undefined || !Number.isFinite(seconds)) return value
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** One cell, already unwrapped from Google's `{ v }` wrapper. `cut` says whether anything was lost. */
export function cellValue(value: unknown, field: SchemaField | undefined): { value: unknown; cut: boolean } {
  if (value === null || value === undefined) return { value: null, cut: false }
  const type = (field?.type ?? "").toUpperCase()
  const repeated = field?.mode === "REPEATED" || type === "ARRAY"

  if (repeated || type === "STRUCT" || type === "RECORD" || type === "JSON" || (value !== null && typeof value === "object")) {
    let text: string
    try {
      text = JSON.stringify(value) ?? "null"
    } catch {
      text = String(value)
    }
    return cutText(text)
  }
  if (type === "BYTES") {
    const text = String(value)
    return text.length > BYTES_CELL ? { value: `${text.slice(0, BYTES_CELL - 1)}…`, cut: true } : { value: text, cut: false }
  }
  if (type === "INT64") {
    if (typeof value === "number") return { value: isSafeInteger(value) ? value : String(value), cut: false }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = Number(value)
      return { value: Number.isSafeInteger(parsed) ? parsed : value, cut: false }
    }
    return cutText(String(value))
  }
  if (type === "NUMERIC" || type === "BIGNUMERIC") return cutText(String(value))
  if (type === "FLOAT64") {
    if (typeof value === "number") return { value, cut: false }
    if (typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())) return { value: Number(value), cut: false }
    return cutText(String(value))
  }
  if (type === "BOOL") {
    if (typeof value === "boolean") return { value, cut: false }
    if (value === "true" || value === "false") return { value: value === "true", cut: false }
    return cutText(String(value))
  }
  if (type === "TIMESTAMP") return cutText(String(timestamp(value)))
  if (value !== null && typeof value === "object") return cutText(JSON.stringify(value) ?? "null")
  return cutText(String(value))
}

/**
 * One row of a page, as an array of values. Google's own form is `{ f: [{ v }] }`; an already-converted row is an array
 * and is left alone. The `{ v }` wrapper is removed here, where the row's own shape says it is that form, so a STRUCT
 * with a field named `v` is never mistaken for one.
 */
export function rowValues(row: unknown): unknown[] {
  if (Array.isArray(row)) return row
  if (row !== null && typeof row === "object" && Array.isArray((row as { f?: unknown }).f)) {
    return (row as { f: unknown[] }).f.map((cell) => (cell !== null && typeof cell === "object" && "v" in cell && Object.keys(cell).length === 1 ? (cell as { v: unknown }).v : cell))
  }
  return [row]
}

export interface ShapeInput {
  readonly schema: readonly SchemaField[] | undefined
  readonly rows: readonly unknown[]
  readonly maxRows: number
  readonly maxInlineBytes: number
}

export function shapeRows(input: ShapeInput): ShapedRows {
  const fields = input.schema ?? []
  const columns: ResultColumn[] = fields.map((field) => ({ name: cutText(field.name).value, type: field.type }))
  const out: unknown[][] = []
  let cells = false
  let bytes = false
  let used = 0
  for (const row of input.rows.slice(0, input.maxRows)) {
    const values = rowValues(row)
    const shaped = values.map((value, index) => {
      const converted = cellValue(value, fields[index])
      if (converted.cut) cells = true
      return converted.value
    })
    const size = Buffer.byteLength(JSON.stringify(shaped) ?? "")
    if (used + size > input.maxInlineBytes && out.length > 0) {
      bytes = true
      break
    }
    used += size
    out.push(shaped)
    if (used >= input.maxInlineBytes) {
      bytes = true
      break
    }
  }
  return {
    columns,
    rows: out,
    returned: out.length,
    truncated: { rows: input.rows.length > out.length, cells, bytes },
  }
}
