/**
 * The source contract's per-operation read (contract L1): "a dotted operation … is asserted as `<namespace>.read` on
 * `<account>:<operation>`". A consumer's session grants the source's method on `*` and `bigquery.read` on each declared
 * operation (`permission.sessionRules`), so each read asserts exactly that rule, from the contract's own
 * `operationRule`, before its first Google call. A person's off switch for one operation is then consulted, and the
 * conformance kit's declared-equals-asserted check holds under the grants a real consumer makes.
 */
import { operationRule } from "@we-the-rebel-alliance/source-contract/permission"
import type { SourceDeps } from "./events.js"

/** The parts of a source item the rule reads: its id (the namespace) and its accounts. */
export interface SourceRef {
  readonly id: string
  readonly accounts: { readonly named: boolean }
}

export const JOBS_SOURCE: SourceRef = { id: "bigquery.jobs", accounts: { named: true } }
export const SAVED_SOURCE: SourceRef = { id: "bigquery.saved", accounts: { named: true } }

/** Asserts the contract's rule for each operation, in order. */
export async function assertSourceReads(deps: Pick<SourceDeps, "account" | "call">, source: SourceRef, operations: readonly string[]): Promise<void> {
  for (const operation of operations) {
    const rule = operationRule(source, operation, deps.account)
    await deps.call.assert({ action: rule.action, resources: [rule.resource], metadata: { account: deps.account, operation } })
  }
}
