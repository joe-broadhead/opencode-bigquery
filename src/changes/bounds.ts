/**
 * The one sentence a plan's preview carries about what bounds the change (design §5.2). The wording is the design's,
 * verbatim where it is a promise to the person:
 * - the cap bounds it;
 * - the cap may not bound it, with the reason and the job's time limit;
 * - it bills outside the byte cap (AI/ML, a Python UDF, a remote function);
 * - a script, whose estimate covers only the leading statements and whose cap may apply to each child (live check L15);
 * - CREATE MODEL, which bills at BigQuery ML rates;
 * - an admin change, which shows the reason the person gave.
 *
 * A reason or an effect label is built only from fixed words and validated identifiers: never from Google's text and
 * never from the data (§5.6).
 */
import type { Category } from "../domain/actions.js"
import type { StatementType } from "../domain/statements.js"

/**
 * The script sentence, verbatim from design §5.2. Google's multi-statement page (read 18 Nov 2026,
 * https://cloud.google.com/bigquery/docs/multi-statement-queries) says a dry run “validates the first DDL statement and
 * then stops”, stops at `CALL`, `EXECUTE IMMEDIATE` and `FOR`/`IF`/`WHILE`, and that “dry runs of `CREATE TEMP TABLE`
 * statements aren't supported”; each statement “runs as its own job” (child jobs). Live check L15 settles whether the
 * parent's cap bounds each child or the total.
 */
export const SCRIPT_BOUND =
  "A script: the estimate covers only the statements before the first `CALL`, DDL, `EXECUTE IMMEDIATE` or " +
  "`FOR`/`IF`/`WHILE`; each statement runs as its own job, and until L15 settles it the cap may apply to each child, " +
  "so the bound is up to one cap per statement."

/** CREATE MODEL's fixed sentence (design §5.2; BigQuery ML rates, design §17 [17]). */
export const TRAINING_BOUND = "Training bills at BigQuery ML rates."

/** The cap holds (design §5.2). */
export const CAP_BOUND = "The cap bounds this statement."

/** What a statement billed outside bytes: Google's own categories, in the design's words. */
export function effectLabels(effects: readonly string[]): string[] {
  const labels = new Set<string>()
  for (const effect of effects) {
    const upper = effect.toUpperCase()
    if (upper === "A PYTHON UDF") labels.add("Python UDF")
    else if (upper === "A JAVASCRIPT UDF") labels.add("JavaScript UDF")
    else if (upper === "A REMOTE FUNCTION") labels.add("remote function")
    else if (upper.startsWith("ML.") || upper.startsWith("AI.") || upper.startsWith("SAFE.ML.") || upper.startsWith("SAFE.AI.")) labels.add("AI/ML (Vertex)")
    else if (upper === "EXTERNAL_QUERY") labels.add("EXTERNAL_QUERY")
    else if (upper.endsWith("GET_ACCESS_URL")) labels.add("OBJ.GET_ACCESS_URL")
    else labels.add(safeEffect(effect))
  }
  return [...labels]
}

/** An effect name from the lexer, shown only when it is a plain identifier. */
function safeEffect(effect: string): string {
  return /^[A-Za-z0-9_.]{1,40}$/.test(effect) ? effect : "an external function"
}

export interface BoundInput {
  readonly category: Category
  readonly statementType: StatementType
  readonly capEnforceable: boolean
  /** Why the cap cannot bound it, from `capVerdict` (already validated identifiers). */
  readonly capWhyNot?: string
  readonly jobTimeoutSeconds: number
  readonly effects: readonly string[]
  /** The reason the person gave, for an admin plan. */
  readonly reason?: string
  /** True when the targets came from a DML statement's referenced tables, which do not say which one it writes. */
  readonly referencedTargets?: boolean
}

/** The preview's one sentence (design §5.2). */
export function boundSentence(input: BoundInput): string {
  const sentence = baseSentence(input)
  // A DML's target is not in a DDL field: Google names the tables it references, not which one it writes. Say so
  // rather than implying the target is exact.
  return input.referencedTargets === true
    ? `${sentence} BigQuery's dry run names the tables a DML statement references, not which one it writes.`
    : sentence
}

function baseSentence(input: BoundInput): string {
  if (input.statementType === "SCRIPT") return SCRIPT_BOUND
  if (input.category === "admin") {
    return input.reason !== undefined ? `The reason you gave: ${input.reason}` : "An admin change; its effects follow its statement type."
  }
  if (input.statementType === "CREATE_MODEL") return TRAINING_BOUND
  if (input.effects.length > 0) {
    return `Billed outside the byte cap: ${effectLabels(input.effects).join(", ")}.`
  }
  if (input.capEnforceable) return CAP_BOUND
  return `The cap may not bound this query: ${input.capWhyNot ?? "an unknown condition"}. BigQuery bills what it actually reads. The job stops after ${input.jobTimeoutSeconds} seconds.`
}
