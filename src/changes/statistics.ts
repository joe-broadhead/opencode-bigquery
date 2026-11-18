/**
 * What Google's `statistics.query` says about a change, beyond Day 0's `DryRunStatistics`, and the objects the dry run
 * names as the change's targets.
 *
 * The names and meanings below are Google's Job resource, `JobStatistics2`, read on 18 Nov 2026
 * (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#JobStatistics2):
 * - `ddlOperationPerformed`: “The DDL operation performed, possibly dependent on the pre-existence of the DDL target.”
 * - `ddlTargetTable`: “The DDL target table. Present only for CREATE/DROP TABLE/VIEW and DROP ALL ROW ACCESS POLICIES
 *   queries.”
 * - `ddlDestinationTable`: “The table after rename. Present only for ALTER TABLE RENAME TO query.”
 * - `ddlTargetRowAccessPolicy`: “The DDL target row access policy. Present only for CREATE/DROP ROW ACCESS POLICY
 *   queries.” Its reference has `projectId`, `datasetId`, `tableId` and `policyId`.
 * - `ddlTargetRoutine`: “[Beta] The DDL target routine. Present only for CREATE/DROP FUNCTION/PROCEDURE queries.”
 * - `ddlTargetDataset`: “The DDL target dataset. Present only for CREATE/ALTER/DROP SCHEMA(dataset) queries.”
 * - `dclTargetTable` / `dclTargetView` / `dclTargetDataset`: “Referenced table/view/dataset for DCL statement.”
 * - `numDmlAffectedRows`: “The number of rows affected by a DML statement. Present only for DML statements INSERT,
 *   UPDATE or DELETE.”
 *
 * Day 0's `DryRunStatistics` lists only the fields the read guards use, so package B's port copies those and drops
 * these. D reads them through this structural extension; the pull request's contract request asks for them in
 * `src/domain/google.ts` and for package B to carry them, with the citation above. Nothing here is guessed: a field
 * that is absent simply names no target, and the preview says what BigQuery did not say.
 */
import type { DatasetReference, DryRunStatistics, RoutineReference, TableReference } from "../domain/google.js"

/** `RowAccessPolicyReference`: `projectId`, `datasetId`, `tableId`, `policyId` (Job page, above). */
export interface RowAccessPolicyReference {
  readonly projectId: string
  readonly datasetId: string
  readonly tableId: string
  readonly policyId: string
}

/** The `statistics.query` fields a change uses that Day 0's type does not carry. */
export interface ChangeStatistics extends DryRunStatistics {
  readonly ddlOperationPerformed?: string
  readonly ddlTargetTable?: TableReference
  readonly ddlDestinationTable?: TableReference
  readonly ddlTargetRowAccessPolicy?: RowAccessPolicyReference
  readonly ddlTargetRoutine?: RoutineReference
  readonly ddlTargetDataset?: DatasetReference
  readonly dclTargetTable?: TableReference
  readonly dclTargetView?: TableReference
  readonly dclTargetDataset?: DatasetReference
  readonly numDmlAffectedRows?: string
}

/** The dry-run answer as the change guards read it. The extras are absent when the port does not carry them. */
export function changeStatistics(statistics: DryRunStatistics): ChangeStatistics {
  return statistics as ChangeStatistics
}

/** What kind of object a change's target is: the dry run's own words, not a parse of the SQL. */
export type TargetKind = "table" | "view" | "dataset" | "routine" | "row access policy"

/** One object the dry run names as the statement's target. */
export interface Target {
  readonly kind: TargetKind
  readonly project: string
  readonly dataset: string
  /** The object's id in the dataset; for a row access policy, the table it applies to. */
  readonly name: string
  /** A row access policy's id, when the target is one. */
  readonly policyId?: string
  /** The target as the preview shows it, each part validated (design §5.6). */
  readonly label: string
  /** Which dry-run field named it: a DDL/DCL target, or a DML's referenced tables. */
  readonly source: "ddl" | "dcl" | "referenced"
}

/** A target part shown in a preview: a Google identifier, or `object` when it is not one. */
const SAFE_PART = /^[A-Za-z0-9_.:-]{1,64}$/
const part = (value: string) => (SAFE_PART.test(value) ? value : "object")
const label = (parts: readonly string[]) => parts.map(part).join(".")

/** The statement types whose target is the table a DML statement writes; Google names it in `referencedTables`. */
const DML_TARGETS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE_TABLE", "LOAD_DATA"])

/** A view's DDL target is a view, not a table (the Job page's `ddlTargetTable` covers both). */
const VIEW_TYPES = new Set(["CREATE_VIEW", "DROP_VIEW", "ALTER_VIEW"])

/**
 * The objects a statement creates, changes or drops, from BigQuery's own dry-run answer:
 * the DDL/DCL target fields when the statement is a DDL or DCL statement, and for a DML statement the tables the dry
 * run lists as referenced (Google's `referencedTables` is the only place a DML target appears: `ddlTargetTable` is
 * present only for DDL). An empty list means the dry run named no target, which the preview states.
 */
export function targetsOf(
  statistics: ChangeStatistics,
  statementType: string,
  referencedTables: readonly TableReference[] = [],
): Target[] {
  const found = new Map<string, Target>()
  const add = (target: Target) => {
    const key = [target.kind, target.project, target.dataset, target.name, target.policyId ?? ""].join("|")
    if (!found.has(key)) found.set(key, target)
  }
  const table = (kind: "table" | "view", ref: TableReference, source: "ddl" | "dcl" | "referenced" = "ddl") =>
    add({ kind, project: ref.projectId, dataset: ref.datasetId, name: ref.tableId, label: label([ref.projectId, ref.datasetId, ref.tableId]), source })
  const dataset = (ref: DatasetReference, source: "ddl" | "dcl" = "ddl") =>
    add({ kind: "dataset", project: ref.projectId, dataset: ref.datasetId, name: ref.datasetId, label: label([ref.projectId, ref.datasetId]), source })

  const ddlKind = VIEW_TYPES.has(statementType) ? "view" : "table"
  if (statistics.ddlTargetTable !== undefined) table(ddlKind, statistics.ddlTargetTable, "ddl")
  if (statistics.ddlDestinationTable !== undefined) table(ddlKind, statistics.ddlDestinationTable, "ddl")
  if (statistics.ddlTargetDataset !== undefined) dataset(statistics.ddlTargetDataset, "ddl")
  if (statistics.ddlTargetRoutine !== undefined) {
    const ref = statistics.ddlTargetRoutine
    add({ kind: "routine", project: ref.projectId, dataset: ref.datasetId, name: ref.routineId, label: label([ref.projectId, ref.datasetId, ref.routineId]), source: "ddl" })
  }
  if (statistics.ddlTargetRowAccessPolicy !== undefined) {
    const ref = statistics.ddlTargetRowAccessPolicy
    add({
      kind: "row access policy",
      project: ref.projectId,
      dataset: ref.datasetId,
      name: ref.tableId,
      policyId: ref.policyId,
      label: `${label([ref.projectId, ref.datasetId, ref.tableId])} (policy ${part(ref.policyId)})`,
      source: "ddl",
    })
  }
  // DCL: GRANT/REVOKE name their object in `dclTarget*`, not in the DDL fields.
  if (statistics.dclTargetTable !== undefined) table("table", statistics.dclTargetTable, "dcl")
  if (statistics.dclTargetView !== undefined) table("view", statistics.dclTargetView, "dcl")
  if (statistics.dclTargetDataset !== undefined) dataset(statistics.dclTargetDataset, "dcl")

  // TODO(L7, L13): whether a DML statement's `referencedTables` includes the table it writes is unconfirmed; the live
  // check records it. Until then the preview says so, and this is the only answer Google's dry run gives for a DML.
  if (found.size === 0 && DML_TARGETS.has(statementType)) {
    for (const ref of referencedTables) table("table", ref, "referenced")
  }
  return [...found.values()]
}
