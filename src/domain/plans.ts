/**
 * A plan's own data, and the types the commit's re-check compares. The plan id, its one use and its expiry belong to the
 * contract's `register` (contract §6): a planning method answers `{ method, … }` and the register mints the id, keeps the
 * answer as `call.plan` and spends it once. This module therefore holds only what a change's plan means.
 */
import type { StatementType } from "./statements.js";

/**
 * One object a change creates, changes or drops, as the dry run names it (`ddlTarget*` and `dclTarget*`). A commit
 * compares them structurally for `PLAN_CHANGED`. For a dataset, `name` is the dataset too. `label` is what a person
 * reads, such as `proj.ds.t`.
 */
export interface PlanTarget {
  readonly kind: "table" | "view" | "dataset" | "routine" | "row access policy";
  readonly project: string;
  readonly dataset: string;
  readonly name: string;
  readonly policyId?: string;
  readonly label: string;
}

/** The statement one plan holds: exactly what the commit re-checks and runs. */
export interface PlannedStatement {
  readonly sql: string;
  readonly params?: Readonly<Record<string, unknown>> | readonly unknown[];
  readonly project: string;
  readonly location: string;
  readonly statementType: StatementType;
  readonly targets: readonly PlanTarget[];
  readonly estimateBytes: number;
  readonly capBytes: number;
  readonly capEnforceable: boolean;
  readonly jobTimeoutSeconds: number;
}

/** One statement of a planned script, as the plan recorded it (the commit re-checks each one). */
export interface PlannedScriptStatement {
  readonly text: string;
  readonly firstLine: string;
  readonly type: string;
  readonly targets: readonly PlanTarget[];
  readonly references: readonly PlanTarget[];
  readonly determined: boolean;
  readonly sourceMissing?: boolean;
}

/** A change's plan: its category, its statement, who asked and the reason the preview showed. */
export interface PlannedChange {
  readonly category: "write" | "export" | "share" | "delete" | "admin";
  readonly account: string;
  readonly sessionID: string;
  readonly statement: PlannedStatement;
  readonly reason?: string;
  readonly script?: { readonly statements: readonly PlannedScriptStatement[] };
}

/** An uncapped read's plan: the same statement, for the `query` path the byte cap cannot bound. */
export interface PlannedRead {
  readonly account: string;
  readonly sessionID: string;
  readonly statement: PlannedStatement;
}
