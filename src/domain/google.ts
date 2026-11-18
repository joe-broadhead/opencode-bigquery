/**
 * The parts of BigQuery's REST API v2 the plugin reads, as types, and Google's fixed addresses. Only fields the design
 * uses are listed; every one is in Google's reference (design §17: the Job, Table and Routine resources, jobs.insert,
 * jobs.query, jobs.getQueryResults, tabledata.list, rowAccessPolicies.list, tables.testIamPermissions). Values Google
 * sends as int64 arrive as strings and stay strings here; the runtime converts them.
 */

export const GOOGLE = {
  /** BigQuery's REST base. */
  api: "https://bigquery.googleapis.com/bigquery/v2",
  /** Google's OAuth token endpoint: code exchange and refresh, with DPoP proofs. */
  token: "https://oauth2.googleapis.com/token",
  /** Google's authorization endpoint. */
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
} as const

/** The hosts the plugin may send a request to. Anything else is a bug; the host tests block it. */
export const GOOGLE_HOSTS: readonly string[] = ["bigquery.googleapis.com", "oauth2.googleapis.com"]

export interface TableReference {
  readonly projectId: string
  readonly datasetId: string
  readonly tableId: string
}

export interface RoutineReference {
  readonly projectId: string
  readonly datasetId: string
  readonly routineId: string
}

export interface DatasetReference {
  readonly projectId: string
  readonly datasetId: string
}

export interface JobReference {
  readonly projectId: string
  readonly jobId: string
  readonly location?: string
}

/** `totalBytesProcessedAccuracy` (dry-run jobs only). */
export type Accuracy = "PRECISE" | "UPPER_BOUND" | "LOWER_BOUND" | "UNKNOWN"

/**
 * A query parameter, as jobs.insert takes it: Google's `QueryParameter`, serialised unchanged. `parameterValue` is
 * Google's `QueryParameterValue` shape, `{ value }` for a scalar and `{ arrayValues: [{ value }] }` for an array, whose
 * `parameterType` is `{ type: "ARRAY", arrayType: { type } }`.
 */
export interface QueryParameter {
  readonly name?: string
  readonly parameterType: { readonly type: string; readonly arrayType?: unknown; readonly structTypes?: unknown }
  readonly parameterValue: unknown
}

/** A field of a table or result schema. */
export interface SchemaField {
  readonly name: string
  readonly type: string
  readonly mode?: "NULLABLE" | "REQUIRED" | "REPEATED"
  readonly description?: string
  readonly fields?: readonly SchemaField[]
  readonly policyTags?: { readonly names?: readonly string[] }
}

/** `statistics.query` of a jobs.insert dry run: present on success, or the plugin refuses (`DRY_RUN_INCOMPLETE`). */
export interface DryRunStatistics {
  readonly statementType?: string
  readonly totalBytesProcessed?: string
  readonly totalBytesProcessedAccuracy?: Accuracy
  readonly referencedTables?: readonly TableReference[]
  readonly referencedLogicalViews?: readonly TableReference[]
  readonly referencedRoutines?: readonly RoutineReference[]
  readonly referencedPropertyGraphs?: readonly { readonly projectId: string; readonly datasetId: string; readonly propertyGraphId: string }[]
  readonly schema?: { readonly fields?: readonly SchemaField[] }
  // What a change names, from JobStatistics2 (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobstatistics2,
  // read 2026-11-18). Google fills each only for some statement types: `ddlTargetTable` for CREATE/DROP TABLE/VIEW and
  // DROP ALL ROW ACCESS POLICIES, `ddlDestinationTable` for ALTER TABLE RENAME TO, `ddlTargetDataset` for SCHEMA
  // statements, `ddlTargetRoutine` for CREATE/DROP FUNCTION/PROCEDURE, `dclTarget*` for GRANT and REVOKE. An absent field
  // is not "no target". `numDmlAffectedRows` is an int64, sent as a string.
  readonly ddlOperationPerformed?: string
  readonly ddlTargetTable?: TableReference
  readonly ddlDestinationTable?: TableReference
  readonly ddlTargetRowAccessPolicy?: { readonly projectId: string; readonly datasetId: string; readonly tableId: string; readonly policyId: string }
  readonly ddlTargetRoutine?: RoutineReference
  readonly ddlTargetDataset?: DatasetReference
  readonly dclTargetTable?: TableReference
  readonly dclTargetView?: TableReference
  readonly dclTargetDataset?: DatasetReference
  readonly numDmlAffectedRows?: string
}

/** Google's error object, as `error` in an answer or `status.errorResult` on a job. Its message is untrusted. */
export interface GoogleErrorProto {
  readonly reason?: string
  readonly location?: string
  readonly message?: string
}

/** The parts of the Table resource the guards read. */
export interface TableInfo {
  readonly tableReference: TableReference
  readonly type?: "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "EXTERNAL" | "SNAPSHOT" | string
  readonly location?: string
  readonly numBytes?: string
  readonly numRows?: string
  readonly lastModifiedTime?: string
  readonly schema?: { readonly fields?: readonly SchemaField[] }
  readonly view?: { readonly query?: string; readonly useLegacySql?: boolean }
  readonly materializedView?: { readonly query?: string }
  readonly externalDataConfiguration?: unknown
  readonly biglakeConfiguration?: unknown
  readonly cloneDefinition?: unknown
  readonly timePartitioning?: { readonly type?: string; readonly field?: string; readonly requirePartitionFilter?: boolean }
  readonly rangePartitioning?: { readonly field?: string; readonly range?: { readonly start?: string; readonly end?: string; readonly interval?: string } }
  readonly requirePartitionFilter?: boolean
  readonly clustering?: { readonly fields?: readonly string[] }
  readonly description?: string
  readonly expirationTime?: string
}

/** The parts of the Routine resource expansion reads. */
export interface RoutineInfo {
  readonly routineReference: RoutineReference
  readonly routineType?: string
  readonly language?: "SQL" | "JAVASCRIPT" | "PYTHON" | "JAVA" | "SCALA" | string
  readonly definitionBody?: string
  readonly remoteFunctionOptions?: unknown
  readonly arguments?: readonly { readonly name?: string; readonly dataType?: unknown }[]
}
