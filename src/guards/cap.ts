/**
 * Whether the byte cap bounds this statement (design §2.1, §5.1 step 7, §6.2). It is a guarantee only when **all** of
 * these hold, and any one of them failing makes the read cap-unenforceable, which sends it to a plan:
 *
 * - the dry run's accuracy is `PRECISE` or `UPPER_BOUND` (a clustered estimate is an upper bound; a federated source's
 *   is a lower bound);
 * - every stored table is native BigQuery storage — `TABLE`, `MATERIALIZED_VIEW`, `SNAPSHOT` or a clone, with no
 *   external data configuration, no BigLake configuration, no object table and no Omni location — whatever the caller
 *   can read of it;
 * - no referenced table has a row access policy, whatever the caller's own filter, from `RowPolicyProber`;
 * - no function bills outside bytes (AI/ML, a Python UDF, a remote function);
 * - and the query's own estimate is above 0 when a referenced table holds data: a fully pruned query that legitimately
 *   estimates 0 is sent to a plan too, which the hint says.
 *
 * `whyNot` is the first condition that failed, in words built here from validated identifiers, never from Google's text.
 */
import type { Accuracy, DryRunStatistics } from "../domain/google.js"
import { path } from "../domain/identifiers.js"
import type { RowVerdict } from "./rowpolicy.js"
import type { TableFacts } from "./tables.js"

export interface CapVerdict {
  readonly enforceable: boolean
  /** The condition that failed, for `whyNot` and the plan preview. Absent when the cap holds. */
  readonly whyNot?: string
}

export interface CapInput {
  readonly statistics: DryRunStatistics
  readonly bytes: number
  readonly tables: readonly TableFacts[]
  /** Routine and lexer effects: a remote function, a Python UDF, `ML.X`, `EXTERNAL_QUERY`, `OBJ.GET_ACCESS_URL`. */
  readonly effects: readonly string[]
  /** References expansion could not resolve: their reads cannot be seen, so the cap cannot be proven either. */
  readonly unresolved?: readonly string[]
  readonly rowPolicy: (facts: TableFacts) => Promise<RowVerdict>
}

export async function capVerdict(input: CapInput): Promise<CapVerdict> {
  if (input.effects.length > 0) {
    return { enforceable: false, whyNot: `the statement is billed or acts outside the bytes: ${input.effects.join(", ")}` }
  }

  if ((input.unresolved?.length ?? 0) > 0) {
    return { enforceable: false, whyNot: "a referenced view or routine could not be resolved, so what the statement reads is not known" }
  }

  const accuracy: Accuracy | undefined = input.statistics.totalBytesProcessedAccuracy
  if (accuracy === undefined) return { enforceable: false, whyNot: "the dry run reported no estimate accuracy, so the estimate may be a lower bound" }
  if (accuracy === "LOWER_BOUND") return { enforceable: false, whyNot: "the estimate is a lower bound" }
  if (accuracy === "UNKNOWN") return { enforceable: false, whyNot: "the dry run's estimate accuracy is unknown" }
  if (accuracy !== "PRECISE" && accuracy !== "UPPER_BOUND") return { enforceable: false, whyNot: "the dry run's estimate accuracy is not one this version trusts" }

  for (const facts of input.tables) {
    if (facts.storage === "native") continue
    const name = path(facts.project, facts.dataset, facts.table)
    return { enforceable: false, whyNot: `the table ${name} is ${facts.whyNotNative ?? "not native BigQuery storage"}` }
  }

  for (const facts of input.tables) {
    if (facts.storage !== "native" || facts.kind !== "data") continue
    const verdict = await input.rowPolicy(facts)
    const name = path(facts.project, facts.dataset, facts.table)
    if (verdict.state === "secured") return { enforceable: false, whyNot: `the table ${name} has a row access policy` }
    if (verdict.state === "unknown") return { enforceable: false, whyNot: `the row-access check on the table ${name} could not be completed (${verdict.why})` }
  }

  if (input.bytes === 0) {
    const nonEmpty = input.tables.find((facts) => facts.kind === "data" && facts.numBytes > 0)
    if (nonEmpty) {
      const name = path(nonEmpty.project, nonEmpty.dataset, nonEmpty.table)
      return { enforceable: false, whyNot: `the estimate is 0 bytes while the table ${name} holds data, so the query may be fully pruned or row-secured` }
    }
  }

  return { enforceable: true }
}

