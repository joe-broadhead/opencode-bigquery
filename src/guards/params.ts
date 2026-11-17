/**
 * Query parameters (design §4 `params`), turned into what `jobs.insert` carries. The input is values only — an object
 * for `@name` parameters or an array for `?` parameters — so the type has to come from the JavaScript value. Anything
 * whose BigQuery type cannot be inferred with certainty is refused rather than guessed: a guessed type is not a safe
 * answer, it is a different query.
 *
 * A `STRUCT` parameter and a `null` need a type the input cannot express (`null` alone has none). A caller who needs
 * one passes it as a JSON string and casts it in the SQL (`CAST(@p AS STRUCT<a INT64>)`), which keeps the input values
 * only. `QueryParameterValue` is Google's own shape (`{ value }`, `{ arrayValues }`).
 */

import { BigQueryError } from "../domain/errors.js"
import type { QueryParameter } from "../domain/google.js"

const MAX_SAFE = Number.MAX_SAFE_INTEGER

const invalid = (what: string) =>
  new BigQueryError(
    "INPUT_INVALID",
    `The query's params cannot be typed: ${what}`,
    "Pass strings, numbers, booleans or arrays of them; for a STRUCT or a null, pass a JSON string and CAST it in the SQL.",
  )

/** The parameter type of one input value. */
function typeOf(value: unknown, depth = 0): { readonly type: string; readonly arrayType?: unknown } {
  if (typeof value === "string") return { type: "STRING" }
  if (typeof value === "boolean") return { type: "BOOL" }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("a number that is not finite")
    if (Number.isInteger(value) && Math.abs(value) > MAX_SAFE) {
      // A JSON number cannot hold an INT64 this large: the value was already rounded before the plugin saw it.
      throw invalid("an integer above 2^53, which a JSON number cannot hold exactly (review LOW 6)")
    }
    return Number.isInteger(value) ? { type: "INT64" } : { type: "FLOAT64" }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw invalid("an empty array has no element type")
    const element = typeOf(value[0], depth + 1)
    if (element.type === "ARRAY") throw invalid("an array of arrays")
    for (const item of value) {
      const other = typeOf(item, depth + 1)
      if (other.type !== element.type) throw invalid("an array whose elements have different types")
    }
    return { type: "ARRAY", arrayType: element }
  }
  if (value === null) throw invalid("a null has no type of its own")
  throw invalid("an object (a STRUCT needs a type the input cannot express)")
}

const scalar = (value: unknown): string => (typeof value === "boolean" ? (value ? "true" : "false") : String(value))

function valueOf(value: unknown): unknown {
  if (Array.isArray(value)) return { arrayValues: value.map((item) => ({ value: scalar(item) })) }
  return { value: scalar(value) }
}

/**
 * `undefined` stays `undefined` (no parameters): the dry run and the run send the same parameters, byte for byte.
 * Named parameters are sorted, so the same input always produces the same request.
 */
export function toQueryParameters(params: Readonly<Record<string, unknown>> | readonly unknown[] | undefined): QueryParameter[] | undefined {
  if (params === undefined) return undefined
  if (Array.isArray(params)) {
    if (params.length === 0) return undefined
    return params.map((value) => ({ parameterType: typeOf(value), parameterValue: valueOf(value) }))
  }
  const entries = Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  if (entries.length === 0) return undefined
  return entries.map(([name, value]) => ({ name, parameterType: typeOf(value), parameterValue: valueOf(value) }))
}

/** The named/positional mode the REST API needs beside the parameters. */
export function parameterMode(params: Readonly<Record<string, unknown>> | readonly unknown[] | undefined): "NAMED" | "POSITIONAL" | undefined {
  if (params === undefined) return undefined
  if (Array.isArray(params)) return params.length > 0 ? "POSITIONAL" : undefined
  return Object.keys(params).length > 0 ? "NAMED" : undefined
}
