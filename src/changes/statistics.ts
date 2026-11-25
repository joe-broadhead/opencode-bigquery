/**
 * A change's targets: the objects BigQuery's dry run names as what the statement creates, changes or drops, and the
 * destination its own leading keywords name when the dry run names none. The `statistics.query` fields this reads are
 * Day 0's `DryRunStatistics` (the contract amendment for package D), documented there from Google's Job resource,
 * `JobStatistics2` (https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#JobStatistics2, read 2026-11-18).
 *
 * Nothing here is guessed. A field Google fills only for some statement types is absent for the rest, and an absent
 * field is not "no target": `changeTargets` then uses the statement's own destination, and a fence refuses a change whose
 * target still cannot be verified rather than assume it is inside.
 */
import type { DatasetReference, DryRunStatistics, RoutineReference, TableReference } from "../domain/google.js"
import type { PlanTarget } from "../domain/plans.js"

export type { PlanTarget } from "../domain/plans.js"

/** What kind of object a change's target is: the dry run's own words, not a parse of the SQL. */
export type TargetKind = "table" | "view" | "dataset" | "routine" | "row access policy"

/** One object the dry run names as the statement's target, and which field named it. */
export interface Target extends PlanTarget {
  /**
   * `ddl`/`dcl`: the dry run's own target field, exact. `statement`: the destination the statement's own leading
   * keywords name (`INSERT INTO`, `UPDATE`, `MERGE INTO`, `TRUNCATE TABLE`, `ALTER TABLE`, …), read by the lexer as a
   * stricter-only addition (review bigquery-8 H-1) and never used to allow anything. `referenced`: a DML's
   * `referencedTables`, which Google does not say is the table written (docs/architecture.md's known limits), so a fence
   * refuses a DML whose only targets are referenced.
   */
  readonly source: "ddl" | "dcl" | "statement" | "referenced"
}

/** A target part shown in a preview: a Google identifier, or `object` when it is not one. */
const SAFE_PART = /^[A-Za-z0-9_.:-]{1,64}$/
const part = (value: string) => (SAFE_PART.test(value) ? value : "object")
const label = (parts: readonly string[]) => parts.map(part).join(".")

/** The statement types whose target is the table a DML statement writes; Google names it in `referencedTables`. */
const DML_TARGETS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE_TABLE", "LOAD_DATA"])

/**
 * The statement types with no dataset-scoped target: a read writes nothing, an export writes a GCS object, an admin
 * statement acts on capacity/reservations/connections, and a transaction alone changes nothing. The dataset fence and a
 * person's table rule have nothing to check for these; reads are fenced on their referenced tables by package C.
 */
const NO_TARGET_TYPES = new Set([
  "SELECT",
  "ASSERT",
  // EXPORT_MODEL and EXPORT_METADATA are NOT here: their source model/table is a target (review bigquery-8 R-1).
  "EXPORT_DATA",
  "CREATE_CAPACITY",
  "CREATE_RESERVATION",
  "CREATE_ASSIGNMENT",
  "CREATE_CONNECTION",
  "DROP_CAPACITY",
  "DROP_RESERVATION",
  "DROP_ASSIGNMENT",
  "DROP_CONNECTION",
  "ALTER_CAPACITY",
  "ALTER_RESERVATION",
  "ALTER_CONNECTION",
  "ALTER_PROJECT",
  "ALTER_ORGANIZATION",
  "ALTER_BI_CAPACITY",
  "BEGIN_TRANSACTION",
  "COMMIT_TRANSACTION",
  "ROLLBACK_TRANSACTION",
])

/** Whether a statement's change is dataset-scoped, so a fence needs the target named before it can be checked. */
export function needsTarget(statementType: string): boolean {
  return !NO_TARGET_TYPES.has(statementType)
}

/**
 * Whether the dry run named a target the fence and a person's rules can rely on. A DML's only candidate is
 * `referencedTables`, which the live check has not confirmed contains the table written; until L7/L13 does, a fence
 * treats a DML as unverified rather than assume it. Absent a fence, the DML's referenced tables are still shown and
 * asserted (best effort), never used to prove the target is inside.
 */
export function targetsVerified(statementType: string, targets: readonly Target[]): boolean {
  if (!needsTarget(statementType)) return true
  if (targets.length === 0) return false
  if (DML_TARGETS.has(statementType) && targets.every((target) => target.source === "referenced")) return false
  return true
}

/** A target part that can be named in a resource or a fence pattern without spoofing it. */
const SAFE_RESOURCE = /^[A-Za-z0-9_.:-]{1,1024}$/

/** Whether every part of a target can be named in a person's rule (`<account>:table:<project>.<dataset>.<name>`). */
export function targetSafe(target: PlanTarget): boolean {
  return SAFE_RESOURCE.test(target.project) && SAFE_RESOURCE.test(target.dataset) && SAFE_RESOURCE.test(target.name)
}

/** Whether two target lists name the same objects (kind, project, dataset, name and policy id), in any order. */
export function sameTargets(left: readonly PlanTarget[], right: readonly PlanTarget[]): boolean {
  const key = (target: PlanTarget) => [target.kind, target.project, target.dataset, target.name, target.policyId ?? ""].join("|")
  const a = left.map(key).sort()
  const b = right.map(key).sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * A statement's change targets, in order of what can be trusted: the dry run's own DDL/DCL fields when it named them;
 * otherwise the destination the statement's leading keywords name; otherwise a DML's referenced tables as a best effort
 * (which a fence treats as unverified). The lexer's destination is never used to override a server-named target, and the
 * server's exact target always stays.
 */
export function changeTargets(server: readonly Target[], destination: Target | undefined, sources: readonly Target[] = []): Target[] {
  const named = server.filter((target) => target.source === "ddl" || target.source === "dcl")
  const base = named.length > 0 ? named : destination !== undefined ? [destination] : server
  // A CLONE/COPY clause's source is an object the statement reads to create the target; it is checked like a target
  // (review bigquery-8 R-1), never used to allow anything.
  return unionTargets(base, sources)
}

/** The objects a statement's dry run says it reads, as fence/assert objects; a property graph is left to package C. */
export function referencesOf(statistics: DryRunStatistics): Target[] {
  const out: Target[] = []
  const add = (kind: "table" | "view" | "routine", project: string, dataset: string, name: string) =>
    out.push({ kind, project, dataset, name, label: label([project, dataset, name]), source: "referenced" })
  for (const ref of statistics.referencedTables ?? []) add("table", ref.projectId, ref.datasetId, ref.tableId)
  for (const ref of statistics.referencedLogicalViews ?? []) add("view", ref.projectId, ref.datasetId, ref.tableId)
  for (const ref of statistics.referencedRoutines ?? []) add("routine", ref.projectId, ref.datasetId, ref.routineId)
  return out
}

/** The deduplicated union of target lists, in first-seen order. */
export function unionTargets(...lists: readonly (readonly Target[])[]): Target[] {
  const found = new Map<string, Target>()
  for (const list of lists) {
    for (const target of list) {
      const key = [target.kind, target.project, target.dataset, target.name, target.policyId ?? ""].join("|")
      if (!found.has(key)) found.set(key, target)
    }
  }
  return [...found.values()]
}

/** A view's DDL target is a view, not a table (the Job page's `ddlTargetTable` covers both). */
const VIEW_TYPES = new Set(["CREATE_VIEW", "DROP_VIEW", "ALTER_VIEW"])

/**
 * The objects a statement creates, changes or drops, from BigQuery's own dry-run answer:
 * the DDL/DCL target fields when the statement is a DDL or DCL statement, and for a DML statement the tables the dry
 * run lists as referenced (Google's `referencedTables` is the only place a DML target appears: `ddlTargetTable` is
 * present only for DDL). An empty list means the dry run named no target, which the preview states.
 */
export function targetsOf(
  statistics: DryRunStatistics,
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

  // Whether a DML statement's `referencedTables` includes the table it writes is a known limit in
  // docs/architecture.md. Until a live check records it, the preview says so, and this is the only answer the dry run gives.
  if (found.size === 0 && DML_TARGETS.has(statementType)) {
    for (const ref of referencedTables) table("table", ref, "referenced")
  }
  return [...found.values()]
}
