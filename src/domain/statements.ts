/**
 * Every `statementType` BigQuery's dry run can report (the Job resource's enum, read on 2026-11-17 into
 * `test/fixtures/statement-types.json` by `scripts/statement-types.mjs`), mapped to what the plugin does with it.
 * `statementType` is BigQuery's own parse of the exact text that then runs, so the plugin decides from it; the lexer can
 * only make a decision stricter (`raise`). A type not in this table is refused (`STATEMENT_UNKNOWN`), and the test
 * fails when the fixture names a type the table does not map, so a new type is classified before it can run.
 *
 * This module imports only types, so scripts can load it directly.
 */
import type { Category } from "../constants.js"

/** What a statement is, before any lexer finding: a read for the read path, or a plan's category. */
export type Kind = "read" | Exclude<Category, "uncapped-read">

/** The statement types, each with its kind (design §5.2). */
export const STATEMENT_KINDS = {
  // Reads: the read path, or an uncapped-read plan when the cap cannot bound them.
  SELECT: "read",
  ASSERT: "read",
  // write → write. A CREATE_* whose target exists is a replace, which the lexer and the plan raise to delete.
  INSERT: "write",
  UPDATE: "write",
  MERGE: "write",
  CREATE_TABLE: "write",
  CREATE_TABLE_AS_SELECT: "write",
  CREATE_VIEW: "write",
  CREATE_MODEL: "write",
  CREATE_MATERIALIZED_VIEW: "write",
  CREATE_FUNCTION: "write",
  CREATE_TABLE_FUNCTION: "write",
  CREATE_PROCEDURE: "write",
  CREATE_SCHEMA: "write",
  CREATE_EXTERNAL_SCHEMA: "write",
  CREATE_EXTERNAL_TABLE: "write",
  CREATE_SNAPSHOT_TABLE: "write",
  CREATE_SEARCH_INDEX: "write",
  CREATE_VECTOR_INDEX: "write",
  CREATE_PROPERTY_GRAPH: "write",
  ALTER_TABLE: "write",
  ALTER_VIEW: "write",
  ALTER_MATERIALIZED_VIEW: "write",
  ALTER_SCHEMA: "write",
  ALTER_MODEL: "write",
  ALTER_SEARCH_INDEX: "write",
  ALTER_VECTOR_INDEX: "write",
  UNDROP_SCHEMA: "write",
  LOAD_DATA: "write",
  // export → export.
  EXPORT_DATA: "export",
  EXPORT_MODEL: "export",
  EXPORT_METADATA: "export",
  // share → share.
  GRANT_ON_SCHEMA: "share",
  GRANT_ON_TABLE: "share",
  GRANT_ON_VIEW: "share",
  GRANT_ON_PROJECT: "share",
  REVOKE_ON_SCHEMA: "share",
  REVOKE_ON_TABLE: "share",
  REVOKE_ON_VIEW: "share",
  REVOKE_ON_PROJECT: "share",
  CREATE_ROW_ACCESS_POLICY: "share",
  DROP_ROW_ACCESS_POLICY: "share",
  CREATE_DATA_POLICY: "share",
  ALTER_DATA_POLICY: "share",
  DROP_DATA_POLICY: "share",
  // delete → delete.
  DELETE: "delete",
  TRUNCATE_TABLE: "delete",
  DROP_TABLE: "delete",
  DROP_EXTERNAL_TABLE: "delete",
  DROP_VIEW: "delete",
  DROP_MODEL: "delete",
  DROP_MATERIALIZED_VIEW: "delete",
  DROP_FUNCTION: "delete",
  DROP_TABLE_FUNCTION: "delete",
  DROP_PROCEDURE: "delete",
  DROP_SEARCH_INDEX: "delete",
  DROP_VECTOR_INDEX: "delete",
  DROP_SCHEMA: "delete",
  DROP_SNAPSHOT_TABLE: "delete",
  DROP_PROPERTY_GRAPH: "delete",
  SCRIPT: "delete",
  CALL: "delete",
  BEGIN_TRANSACTION: "delete",
  COMMIT_TRANSACTION: "delete",
  ROLLBACK_TRANSACTION: "delete",
  // admin → admin: capacity, reservations, assignments, connections, project and organisation settings.
  CREATE_CAPACITY: "admin",
  CREATE_RESERVATION: "admin",
  CREATE_ASSIGNMENT: "admin",
  CREATE_CONNECTION: "admin",
  DROP_CAPACITY: "admin",
  DROP_RESERVATION: "admin",
  DROP_ASSIGNMENT: "admin",
  DROP_CONNECTION: "admin",
  ALTER_CAPACITY: "admin",
  ALTER_RESERVATION: "admin",
  ALTER_CONNECTION: "admin",
  ALTER_PROJECT: "admin",
  ALTER_ORGANIZATION: "admin",
  ALTER_BI_CAPACITY: "admin",
} as const satisfies Record<string, Kind>

export type StatementType = keyof typeof STATEMENT_KINDS

export const STATEMENT_TYPES = Object.keys(STATEMENT_KINDS) as readonly StatementType[]

export function isStatementType(value: string): value is StatementType {
  return Object.hasOwn(STATEMENT_KINDS, value)
}

/** The kind of a reported type, or `undefined` for a type this version does not know (`STATEMENT_UNKNOWN`). */
export function kindOf(statementType: string): Kind | undefined {
  return isStatementType(statementType) ? STATEMENT_KINDS[statementType] : undefined
}

/**
 * Strictness, lowest first. A lexer finding can only move a decision up this list; `stricter` keeps the higher one.
 * `admin` is highest because it needs a reason as well as a write account.
 */
export const STRICTNESS: readonly Kind[] = ["read", "write", "export", "share", "delete", "admin"]

export function stricter(a: Kind, b: Kind): Kind {
  return STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b
}

/** A lexer's decision raised onto the table's: never lower. */
export function raise(table: Kind, finding: Kind | undefined): Kind {
  return finding === undefined ? table : stricter(table, finding)
}
