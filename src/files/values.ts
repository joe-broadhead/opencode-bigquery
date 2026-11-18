/**
 * A result page's values as a saved file holds them (design §7), from the same rules package B's read path uses:
 *
 * - INT64 is a number only inside ±(2^53−1); outside it the exact decimal text stays a string;
 * - NUMERIC and BIGNUMERIC stay strings, FLOAT64 a number, its `NaN`/`Infinity` strings;
 * - TIMESTAMP is ISO 8601 UTC with microseconds kept, DATE, TIME, DATETIME, JSON, BYTES (base64), GEOGRAPHY (WKT) and
 *   INTERVAL their text;
 * - STRUCT is an object keyed by its fields' names, ARRAY an array, however deeply nested; RANGE `{ start, end }`.
 *
 * A page may arrive in Google's wire form (`{ f: [{ v }] }`, nested the same way) or already converted; both are
 * accepted (`src/ports.ts` `ResultPage.rows`). Unlike an inline cell, a file cell is **not** cut: a file is for charts
 * and for the person, not for a model's context.
 */
import type { SchemaField } from "../domain/google.js"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A cell's value: Google's `{ v }` wrapper or the bare value. */
export function valueOf(cell: unknown): unknown {
  return isRecord(cell) && "v" in cell && Object.keys(cell).length === 1 ? cell.v : cell
}

/** Google's type names, old and new. */
export function baseType(type: string | undefined): string {
  switch ((type ?? "").toUpperCase()) {
    case "INTEGER":
      return "INT64"
    case "FLOAT":
      return "FLOAT64"
    case "BOOLEAN":
      return "BOOL"
    case "RECORD":
      return "STRUCT"
    default:
      return (type ?? "").toUpperCase()
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const MICROS_PER_SECOND = 1_000_000n
const MAX_DATE_MS = 8.64e15

function int64(value: string | undefined): number | string | null {
  if (value === undefined) return null
  if (!/^[-+]?\d+$/.test(value)) return value
  const big = BigInt(value)
  return big <= MAX_SAFE && big >= MIN_SAFE ? Number(big) : value
}

function float64(value: string | undefined): number | string | null {
  if (value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

/** Microseconds since the epoch from Google's text (integer microseconds, or seconds in either form). */
function microsOf(text: string): bigint | undefined {
  if (/^[-+]?\d+$/.test(text)) return BigInt(text)
  const match = /^([-+]?)(\d+)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(text)
  if (!match) return undefined
  const sign = match[1] === "-" ? -1n : 1n
  const whole = BigInt(match[2] ?? "0")
  const fraction = BigInt((match[3] ?? "").slice(0, 6).padEnd(6, "0") || "0")
  const exponent = Number(match[4] ?? "0")
  const seconds = whole * MICROS_PER_SECOND + fraction
  const scaled = exponent === 0 ? seconds : exponent > 0 ? seconds * 10n ** BigInt(exponent) : seconds / 10n ** BigInt(-exponent)
  return sign * scaled
}

function timestamp(value: string | undefined): string | null {
  if (value === undefined) return null
  const micros = microsOf(value.trim())
  if (micros === undefined) return value
  const seconds = micros / MICROS_PER_SECOND - (micros % MICROS_PER_SECOND < 0n ? 1n : 0n)
  const fraction = micros - seconds * MICROS_PER_SECOND
  const time = Number(seconds) * 1000
  if (!Number.isFinite(time) || Math.abs(time) > MAX_DATE_MS) return value
  const base = new Date(time).toISOString().slice(0, 19)
  return fraction === 0n ? `${base}.000Z` : `${base}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}Z`
}

/** One cell's value, by its field and its mode. */
export function convertValue(field: SchemaField | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (field === undefined) return isRecord(value) && Array.isArray(value["f"]) ? (value["f"] as unknown[]).map(valueOf) : value
  if (field.mode === "REPEATED") {
    const items = Array.isArray(value) ? value : [value]
    return items.map((item) => convertValue({ ...field, mode: "NULLABLE" }, valueOf(item)))
  }
  switch (baseType(field.type)) {
    case "INT64":
      return int64(typeof value === "string" ? value : String(value))
    case "FLOAT64":
      return float64(typeof value === "string" ? value : String(value))
    case "NUMERIC":
    case "BIGNUMERIC":
      return typeof value === "string" ? value : String(value)
    case "BOOL":
      return value === true || value === "true" || value === "TRUE"
    case "TIMESTAMP":
      return timestamp(typeof value === "string" ? value : String(value))
    case "STRUCT": {
      const nested = isRecord(value) && Array.isArray(value["f"]) ? (value["f"] as unknown[]) : undefined
      if (nested === undefined) return value
      const out: Record<string, unknown> = {}
      for (const [index, child] of (field.fields ?? []).entries()) out[child.name] = convertValue(child, valueOf(nested[index]))
      return out
    }
    case "RANGE": {
      if (isRecord(value)) return { start: valueOf(value["start"]), end: valueOf(value["end"]) }
      return value
    }
    default:
      return value
  }
}

/** One page's rows as arrays in the schema's order. A short row is padded with nulls, never shifted. */
export function convertRows(fields: readonly SchemaField[], rows: readonly unknown[]): unknown[][] {
  return rows.map((row) => {
    const cells = isRecord(row) && Array.isArray(row["f"]) ? (row["f"] as unknown[]) : Array.isArray(row) ? row : []
    return fields.map((field, index) => convertValue(field, valueOf(cells[index])))
  })
}

/** A value as a CSV field: null is empty, nested values their JSON text, everything else as text. */
export function csvText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value) ?? ""
}

/** A CSV field, quoted as RFC 4180 asks when it holds a comma, a quote, or a line break. */
export function csvCell(value: unknown): string {
  const text = csvText(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The physical type a field's values are written as in Parquet; nested values are JSON text. */
export function parquetType(field: SchemaField | undefined): "BOOLEAN" | "INT64" | "DOUBLE" | "BYTE_ARRAY" {
  if (field === undefined || field.mode === "REPEATED") return "BYTE_ARRAY"
  switch (baseType(field.type)) {
    case "BOOL":
      return "BOOLEAN"
    case "INT64":
      return "INT64"
    case "FLOAT64":
      return "DOUBLE"
    default:
      return "BYTE_ARRAY"
  }
}

/** A value as a Parquet cell for its column's physical type. */
export function parquetCell(value: unknown, type: "BOOLEAN" | "INT64" | "DOUBLE" | "BYTE_ARRAY"): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (type === "BOOLEAN") return value === true || value === "true"
  if (type === "INT64") return typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? value : String(value)
  if (type === "DOUBLE") return typeof value === "number" ? value : typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ? Number(value) : String(value)
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value) ?? String(value)
}

/** A JSONL value: as converted, so nested objects and arrays stay JSON rather than becoming text. */
export function jsonValue(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === "bigint") return value.toString()
  return value
}
