/**
 * A table as the guards read it (design §5.1 steps 4 and 7, §5.3, §7): whether it is native BigQuery storage, which
 * columns carry a policy tag, how it is partitioned, and the partitioned filter the row-policy probe must satisfy.
 *
 * Every classification fails closed: a type or configuration this version does not recognise is `unknown`, which makes
 * the cap unenforceable and sends the query to a plan, rather than being assumed native.
 */

import type { SchemaField, TableInfo } from "../domain/google.js"
import type { Partitioning } from "../domain/probe.js"

export type Storage = "native" | "external" | "unknown"

export interface TableFacts {
  readonly info: TableInfo
  readonly project: string
  readonly dataset: string
  readonly table: string
  /** `p.d.t`, for messages that validate each part. */
  readonly name: string
  /** `data` reads stored bytes, `view` is expanded, `external` is not BigQuery storage. */
  readonly kind: "data" | "view" | "external" | "unknown"
  readonly storage: Storage
  /** Why it is not native storage, in words built from the resource's own fields, for the cap sentence. */
  readonly whyNotNative?: string
  readonly columns: readonly SchemaField[]
  /** Top-level columns that are tagged themselves or hold a tagged nested field (§5.3). */
  readonly tagged: readonly string[]
  readonly partitioning?: Partitioning
  readonly requirePartitionFilter: boolean
  readonly numBytes: number
  readonly location?: string
}

/** The types whose values an aggregate can compare, for `profile`. */
const ORDERABLE = new Set(["STRING", "BYTES", "INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC", "DATE", "TIME", "DATETIME", "TIMESTAMP"])
/** The numeric types `APPROX_QUANTILES` accepts. */
export const NUMERIC_TYPES = new Set(["INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC"])
/** The types whose values can be grouped for `APPROX_TOP_COUNT` and counted exactly. */
export const GROUPABLE = new Set(["STRING", "BYTES", "INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC", "DATE", "TIME", "DATETIME", "TIMESTAMP", "BOOL"])

export const isOrderable = (type: string) => ORDERABLE.has(type.toUpperCase())
export const isRepeated = (field: SchemaField) => field.mode === "REPEATED"
/** A column whose value cannot be counted, compared or grouped as a scalar: a STRUCT, a RECORD or JSON. */
export const isStruct = (field: SchemaField) => {
  const type = field.type.toUpperCase()
  return type === "STRUCT" || type === "RECORD" || type === "JSON"
}

const fieldType = (field: SchemaField | undefined) => field?.type.toUpperCase() ?? ""

/** Whether a field, or anything under it, carries a policy tag. */
function tagged(field: SchemaField): boolean {
  if ((field.policyTags?.names?.length ?? 0) > 0) return true
  return (field.fields ?? []).some(tagged)
}

/** The top-level column names that carry a policy tag, directly or in a nested field. */
export function taggedColumns(columns: readonly SchemaField[]): string[] {
  return columns.filter(tagged).map((field) => field.name)
}

/** How the table is partitioned, from `timePartitioning`, `rangePartitioning` and the schema's column type. */
function partitioningOf(info: TableInfo, columns: readonly SchemaField[]): Partitioning | undefined {
  const range = info.rangePartitioning
  if (range?.field) return { kind: "range", column: range.field }
  const time = info.timePartitioning
  if (time?.field) {
    const field = columns.find((column) => column.name === time.field)
    const type = fieldType(field)
    if (type === "DATE" || type === "TIMESTAMP" || type === "DATETIME") return { kind: "column", column: time.field, type }
    // A partitioned column of another type is not one this version knows: the probe cannot build a floor for it.
    return undefined
  }
  if (time !== undefined || info.requirePartitionFilter === true) return { kind: "ingestion" }
  return undefined
}

/** Everything the guards need from one `tables.get` answer. */
export function tableFacts(info: TableInfo): TableFacts {
  const ref = info.tableReference
  const columns = info.schema?.fields ?? []
  const type = (info.type ?? "").toUpperCase()
  const location = info.location
  const omni = location !== undefined && (/^aws-/i.test(location) || /^azure-/i.test(location))
  const external = info.externalDataConfiguration !== undefined || info.biglakeConfiguration !== undefined || type === "EXTERNAL" || omni

  let kind: TableFacts["kind"]
  let storage: Storage
  let whyNotNative: string | undefined
  if (type === "VIEW") {
    kind = "view"
    storage = "native"
  } else if (external) {
    kind = "external"
    storage = "external"
    whyNotNative = info.externalDataConfiguration !== undefined || type === "EXTERNAL" ? "an external table" : info.biglakeConfiguration !== undefined ? "a BigLake table" : "an Omni (AWS or Azure) table"
  } else if (type === "TABLE" || type === "MATERIALIZED_VIEW" || type === "SNAPSHOT" || info.cloneDefinition !== undefined) {
    kind = "data"
    storage = "native"
  } else if (type === "") {
    kind = "unknown"
    storage = "unknown"
    whyNotNative = "a table whose type the tables.get answer does not name"
  } else {
    kind = "unknown"
    storage = "unknown"
    whyNotNative = `a ${type} table, which this version does not classify`
  }

  const partitioning = partitioningOf(info, columns)
  return {
    info,
    project: ref.projectId,
    dataset: ref.datasetId,
    table: ref.tableId,
    name: `${ref.projectId}.${ref.datasetId}.${ref.tableId}`,
    kind,
    storage,
    ...(whyNotNative ? { whyNotNative } : {}),
    columns,
    tagged: taggedColumns(columns),
    ...(partitioning ? { partitioning } : {}),
    requirePartitionFilter: info.requirePartitionFilter === true || info.timePartitioning?.requirePartitionFilter === true,
    numBytes: Number(info.numBytes ?? "0"),
    ...(location !== undefined ? { location } : {}),
  }
}

/** One schema leaf, as `table` shows it: the dotted path, type, mode, description and whether it is tagged. */
export interface FlatColumn {
  readonly path: string
  readonly type: string
  readonly mode?: string
  readonly description?: string
  readonly policyTag: boolean
}

export function flattenSchema(columns: readonly SchemaField[], prefix = "", out: FlatColumn[] = []): FlatColumn[] {
  for (const field of columns) {
    const path = prefix ? `${prefix}.${field.name}` : field.name
    out.push({
      path,
      type: field.type,
      ...(field.mode ? { mode: field.mode } : {}),
      ...(field.description ? { description: cut(field.description) } : {}),
      policyTag: (field.policyTags?.names?.length ?? 0) > 0,
    })
    if (field.fields && field.fields.length > 0) flattenSchema(field.fields, path, out)
  }
  return out
}

/** A cell, description or name cut for a model (§7, §5.6). */
export function cut(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The widest types first, so a per-column probe starts with the one that can show bytes. */
const WIDTH: Readonly<Record<string, number>> = {
  STRING: 100,
  BYTES: 95,
  JSON: 90,
  GEOGRAPHY: 85,
  BIGNUMERIC: 80,
  NUMERIC: 75,
  FLOAT64: 70,
  INT64: 65,
  TIMESTAMP: 60,
  DATETIME: 55,
  DATE: 50,
  TIME: 45,
  BOOL: 40,
  INTERVAL: 30,
  RANGE: 20,
}

export function widestFirst(columns: readonly SchemaField[]): SchemaField[] {
  return [...columns].sort((left, right) => (WIDTH[right.type.toUpperCase()] ?? 10) - (WIDTH[left.type.toUpperCase()] ?? 10))
}
