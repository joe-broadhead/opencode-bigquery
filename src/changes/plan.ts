/**
 * The six planning methods (design §5.2): a change's plan, and the uncapped read's. Each dry-runs its statement through
 * the read guards in `inspect` mode, classifies it from BigQuery's own answer, checks the account's dataset fence, and
 * answers the preview a person reads plus the private statement the commit re-checks. Nothing runs and nothing is
 * stored here: the contract's `register` mints the plan id, keeps the whole answer and spends it once (contract §6).
 *
 * A plan belongs to one class: `plan_write`, `plan_export`, `plan_share`, `plan_delete` and `plan_admin` each refuse a
 * statement of another class and name the planner that takes it, because the contract's `methods` table gives each
 * commit its own class and one plan has exactly one committing method. `plan_query` is the uncapped read's plan.
 */
import { type Category, COMMITTER, PLANNER } from "../constants.js";
import { BigQueryError } from "../domain/errors.js";
import type { PlannedChange, PlannedRead, PlannedStatement } from "../domain/plans.js";
import { cacheOf } from "../guards/cache.js";
import { capAndBudget, usdFor } from "../guards/cost.js";
import { isFenced } from "../guards/fence.js";
import { createLexer, significantTokens } from "../guards/lexer.js";
import { type PreparedRead, prepareRead, readContext } from "../guards/read.js";
import { RowPolicyProber, type RowVerdict } from "../guards/rowpolicy.js";
import { sessionHash } from "../guards/session.js";
import type { AccountSettings } from "../guards/settings.js";
import type { HandlerContext } from "../handlers/context.js";
import { parseBytes } from "../options.js";
import { boundSentence } from "./bounds.js";
import { type ScriptStatementInput, scriptStatements, scriptSummary } from "./scripts.js";
import { statementSources, statementTarget } from "./statement-target.js";
import { changeTargets, type Target, targetSafe, targetsOf, targetsVerified, unionTargets } from "./statistics.js";

/** The default job limit for a script: 300 s unless the caller passes a lower one (design §5.2). */
const SCRIPT_TIMEOUT_SECONDS = 300;

/** A byte size from the input: a number, or a string such as `1GiB`. */
const bytesOf = (value: string | number) => (typeof value === "number" ? value : parseBytes(value));

/** What every planner takes. */
export interface PlanInput {
  readonly sql: string;
  readonly params?: Readonly<Record<string, unknown>> | readonly unknown[];
  readonly project?: string;
  readonly location?: string;
  readonly maxBytes?: string | number;
  readonly jobTimeoutSeconds?: number;
  readonly reason?: string;
}

export interface Classification {
  readonly category: Category | "uncapped-read";
  readonly capEnforceable: boolean;
  readonly jobTimeoutSeconds: number;
}

/**
 * Design §5.2's one table: a statement type (already raised by the lexer) to a category, or a refusal. The lexer can
 * only make this stricter, so the table's kind is never lowered.
 */
export function classify(prepared: PreparedRead, options: HandlerContext["options"], input: { requestedBytes?: number; jobTimeoutSeconds?: number; reason?: string }): Classification {
  if (prepared.kind === "read") {
    if (prepared.effects.length > 0 || prepared.unresolved.length > 0) {
      // §5.1 steps 4 and 5 send these to the change path; only a Read and write account may run them.
      return { category: "write", capEnforceable: prepared.cap.enforceable, jobTimeoutSeconds: normalTimeout(input, options) };
    }
    if (prepared.cap.enforceable) {
      throw new BigQueryError("CATEGORY_MISMATCH", "The SQL is a SELECT the byte cap can bound, so it runs through query and needs no plan", "Call query({ sql }) instead.");
    }
    if (options.uncappedReads === "refuse") {
      throw new BigQueryError(
        "CAP_NOT_ENFORCEABLE",
        `The byte cap cannot bound this query: ${prepared.cap.whyNot ?? "an unknown condition"}, and the account's uncappedReads option refuses one`,
        "Ask the person to set uncappedReads to ask, or narrow the query to native tables without row access policies.",
      );
    }
    return { category: "uncapped-read", capEnforceable: false, jobTimeoutSeconds: uncappedTimeout(input, options) };
  }

  if (prepared.statementType === "SCRIPT") {
    if (!options.scripts) {
      throw new BigQueryError("SCRIPT_REFUSED", "The plugin's scripts option is off, so a script cannot be planned", "Split the script into single statements, or ask the person to set scripts to true.");
    }
    if (input.requestedBytes === undefined) {
      throw new BigQueryError("SCRIPT_CAP_REQUIRED", "A script needs an explicit maxBytes, because its estimate covers only its leading statements", "Plan it again with maxBytes.");
    }
    return { category: prepared.kind, capEnforceable: false, jobTimeoutSeconds: Math.min(input.jobTimeoutSeconds ?? SCRIPT_TIMEOUT_SECONDS, SCRIPT_TIMEOUT_SECONDS) };
  }

  if (prepared.kind === "admin") {
    if (!options.admin.enabled) {
      throw new BigQueryError("ADMIN_DISABLED", "Admin statements are off by the plugin's admin option", "Ask the person to set admin.enabled to true.");
    }
    if (options.admin.requireReason && input.reason === undefined) {
      throw new BigQueryError("ADMIN_REASON_REQUIRED", "An admin plan needs a reason, which the preview shows", "Plan it again with reason.");
    }
  }

  return { category: prepared.kind, capEnforceable: prepared.cap.enforceable, jobTimeoutSeconds: normalTimeout(input, options) };
}

function normalTimeout(input: { jobTimeoutSeconds?: number }, options: HandlerContext["options"]): number {
  return Math.max(1, Math.min(input.jobTimeoutSeconds ?? options.jobTimeoutSeconds, 21_600));
}

function uncappedTimeout(input: { jobTimeoutSeconds?: number }, options: HandlerContext["options"]): number {
  return Math.max(1, Math.min(input.jobTimeoutSeconds ?? options.uncappedTimeoutSeconds, options.uncappedTimeoutSeconds));
}

/**
 * Whether the text defines a temporary table, which a dry run does not support (Google's multi-statement page: "Dry
 * runs of `CREATE TEMP TABLE` statements aren't supported"). This reads statement wording only, never a table name; it
 * is used only to name the refusal a failed dry run deserves, never to decide what a statement touches.
 */
export function definesTempTable(sql: string): boolean {
  const lexed = createLexer().lex(sql);
  if (!lexed.ok) return false;
  const tokens = significantTokens(lexed.tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const word = valueOf(tokens[index]);
    if (word !== "TEMP" && word !== "TEMPORARY") continue;
    if (valueOf(tokens[index + 1]) !== "TABLE") continue;
    for (let back = index - 1; back >= 0 && back >= index - 8; back -= 1) if (valueOf(tokens[back]) === "CREATE") return true;
  }
  return false;
}

const valueOf = (token: ReturnType<typeof significantTokens>[number] | undefined) =>
  token !== undefined && (token.kind === "keyword" || token.kind === "identifier") ? token.value.toUpperCase() : undefined;

/** Whether the account has a fence at all: `datasets: { allow }`, `{ deny }` or both. `{}` is not a fence. */
export function hasFence(fence: AccountSettings["fence"]): boolean {
  return fence?.allow !== undefined || fence?.deny !== undefined;
}

/** A DDL/DCL target outside the account's dataset fence is refused, like any referenced object (design §5.4). */
export function assertTargetsFenced(fence: AccountSettings["fence"], targets: readonly Target[]): void {
  for (const target of targets) {
    const object = { project: target.project, dataset: target.dataset, name: target.name, kind: target.kind };
    if (!isFenced(fence, object)) continue;
    throw new BigQueryError(
      "DATASET_FENCED",
      `The ${target.kind} ${target.label} is outside the account's dataset fence`,
      "Use a dataset the fence allows, or ask the person to change the account's datasets option.",
    );
  }
}

/**
 * The targets a change can be checked on. A fence cannot check what the dry run did not name: a DML (whose only
 * candidates are the unconfirmed `referencedTables`), an `ALTER`/`TRUNCATE`/`LOAD`/`CALL`/`CREATE MODEL` with no target
 * field, a project-level `GRANT`, or a statement whose parts could spoof a resource. Fail closed rather than let the
 * change reach a dataset the fence denies.
 */
export function checkTargets(fence: AccountSettings["fence"], statementType: string, targets: readonly Target[], what: string): void {
  if (hasFence(fence) && (!targetsVerified(statementType, targets) || targets.some((target) => !targetSafe(target)))) {
    throw new BigQueryError(
      "DATASET_FENCED",
      `The target of the ${what} (${statementType}) cannot be verified against the account's dataset fence`,
      "Use a statement whose target BigQuery's dry run names (CREATE/DROP TABLE or VIEW, GRANT/REVOKE, a schema or routine), or ask the person to remove the fence.",
    );
  }
  assertTargetsFenced(fence, targets);
}

/** The referenced objects as the plan's output shows them, with the facts the dry run and expansion saw. */
export async function referencedRecords(prepared: PreparedRead, context: HandlerContext): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const prober = new RowPolicyProber(
    { ports: context.ports, account: context.account, project: prepared.project, signal: context.signal },
    cacheOf<RowVerdict>(context.ports.clock, "rowpolicy", 10 * 60_000, () => context.ports.clock.now()),
  );
  for (const facts of prepared.tables) out.push(tableRecord("table", facts, await rowVerdict(prober, facts)));
  for (const facts of prepared.views) out.push(tableRecord("view", facts));
  for (const routine of prepared.routines) {
    const ref = routine.routineReference;
    out.push({
      kind: "routine",
      name: `${ref.projectId}.${ref.datasetId}.${ref.routineId}`,
      type: routine.routineType ?? "",
      language: routine.language ?? "",
      remote: routine.remoteFunctionOptions !== undefined,
    });
  }
  for (const graph of prepared.statistics.referencedPropertyGraphs ?? []) {
    out.push({ kind: "property graph", name: `${graph.projectId}.${graph.datasetId}.${graph.propertyGraphId}` });
  }
  return out;
}

function tableRecord(kind: "table" | "view", facts: PreparedRead["tables"][number], rowSecured?: boolean | "unknown"): Record<string, unknown> {
  return {
    kind,
    name: facts.name,
    type: facts.info.type ?? "",
    ...(facts.location !== undefined ? { location: facts.location } : {}),
    storage: facts.storage,
    tagged: [...facts.tagged],
    ...(rowSecured !== undefined ? { rowSecured } : {}),
    bytes: facts.numBytes,
    ...(facts.whyNotNative !== undefined ? { whyNotNative: facts.whyNotNative } : {}),
  };
}

/** A native data table's row-access verdict; a view, an external table or an unknown type has no policy of its own. */
async function rowVerdict(prober: RowPolicyProber, facts: PreparedRead["tables"][number]): Promise<boolean | "unknown" | undefined> {
  if (facts.kind !== "data" || facts.storage !== "native") return undefined;
  const verdict = await prober.probe(facts);
  return verdict.state === "secured" ? true : verdict.state === "unknown" ? "unknown" : false;
}

/** The plan's referenced names. */
function referencedNames(prepared: PreparedRead): string[] {
  return [
    ...prepared.tables.map((facts) => facts.name),
    ...prepared.views.map((facts) => facts.name),
    ...prepared.routines.map((routine) => `${routine.routineReference.projectId}.${routine.routineReference.datasetId}.${routine.routineReference.routineId}`),
    ...(prepared.statistics.referencedPropertyGraphs ?? []).map((graph) => `${graph.projectId}.${graph.datasetId}.${graph.propertyGraphId}`),
  ];
}

/** The targets and the statement, checked together against the account's fence. */
async function inspected(input: PlanInput, context: HandlerContext): Promise<{ prepared: PreparedRead; targets: Target[]; references: Target[]; script?: ScriptStatementInput[] }> {
  const requested = input.maxBytes !== undefined ? bytesOf(input.maxBytes) : undefined;
  const rc = readContext({ ports: context.ports, options: context.options, account: context.account, sessionID: context.sessionID, signal: context.signal, via: "plan" });
  let prepared: PreparedRead;
  try {
    prepared = await prepareRead(
      rc,
      {
        sql: input.sql,
        ...(input.params !== undefined ? { params: input.params } : {}),
        ...(input.project !== undefined ? { project: input.project } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(requested !== undefined ? { maxBytes: requested } : {}),
      },
      "inspect",
    );
  } catch (error) {
    // A dry run cannot analyse CREATE TEMP TABLE. BigQuery answers SQL_INVALID; the wording check names the refusal.
    if (error instanceof BigQueryError && error.code === "SQL_INVALID" && definesTempTable(input.sql)) {
      throw new BigQueryError(
        "SCRIPT_NOT_DRY_RUNNABLE",
        "The script creates a temporary table, and BigQuery's dry runs do not support CREATE TEMP TABLE",
        "Replace the temporary table with a CTE or a dataset table, then plan again.",
      );
    }
    throw error;
  }

  const statistics = prepared.statistics;
  const wholeTargets = targetsOf(statistics, prepared.statementType, statistics.referencedTables ?? []);
  let script: ScriptStatementInput[] | undefined;
  let targets: Target[];
  let references: Target[] = [];
  if (prepared.statementType === "SCRIPT") {
    script = await scriptStatements({
      ports: context.ports,
      account: context.account,
      project: prepared.project,
      location: prepared.location,
      ...(prepared.params !== undefined ? { params: prepared.params } : {}),
      signal: context.signal,
      sql: input.sql,
    });
    for (const statement of script) {
      if (!statement.determined) {
        if (hasFence(rc.settings.fence)) {
          throw new BigQueryError(
            "DATASET_FENCED",
            "One of the script's statements could not be dry-run on its own, so its target cannot be verified against the account's dataset fence",
            "Split the script into statements, replace variables or temporary tables with dataset tables, or ask the person to remove the fence.",
          );
        }
        continue;
      }
      if (statement.sourceMissing && hasFence(rc.settings.fence)) {
        throw new BigQueryError(
          "DATASET_FENCED",
          "One of the script's statements copies or clones a table whose source cannot be verified against the account's dataset fence",
          "Name the CLONE or COPY source with a project, dataset and table (backquoted where it needs to be), or ask the person to remove the fence.",
        );
      }
      checkTargets(rc.settings.fence, statement.type, statement.targets, "statement");
      assertTargetsFenced(rc.settings.fence, statement.references);
    }
    assertTargetsFenced(rc.settings.fence, wholeTargets);
    targets = unionTargets(wholeTargets, ...script.map((statement) => statement.targets));
    references = unionTargets(...script.map((statement) => statement.references));
  } else {
    const sources = statementSources(input.sql, prepared.statementType, prepared.project);
    if (sources.required && sources.targets.length === 0 && hasFence(rc.settings.fence)) {
      throw new BigQueryError(
        "DATASET_FENCED",
        "The source of the statement's CLONE or COPY clause cannot be verified against the account's dataset fence",
        "Name the source with a project, dataset and table (backquoted where it needs to be), or ask the person to remove the fence.",
      );
    }
    targets = changeTargets(wholeTargets, statementTarget(input.sql, prepared.statementType, prepared.project), sources.targets);
    checkTargets(rc.settings.fence, prepared.statementType, targets, "statement");
  }
  return { prepared, targets, references, ...(script === undefined ? {} : { script }) };
}

/** The preview's shared part, and the statement the commit re-checks. */
async function classifyAndPreview(input: PlanInput, context: HandlerContext, category: Category | "uncapped-read"): Promise<{ prepared: PreparedRead; targets: Target[]; script?: ScriptStatementInput[]; classification: Classification; statement: PlannedStatement; output: Record<string, unknown> }> {
  const requested = input.maxBytes !== undefined ? bytesOf(input.maxBytes) : undefined;
  const { prepared, targets, references, script } = await inspected(input, context);
  const classification = classify(prepared, context.options, {
    ...(requested !== undefined ? { requestedBytes: requested } : {}),
    ...(input.jobTimeoutSeconds !== undefined ? { jobTimeoutSeconds: input.jobTimeoutSeconds } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  if (classification.category !== category) throw wrongPlanner(category, classification.category);

  const bound = boundSentence({
    category: classification.category as Category,
    statementType: prepared.statementType,
    capEnforceable: classification.capEnforceable,
    ...(prepared.cap.whyNot !== undefined ? { capWhyNot: prepared.cap.whyNot } : {}),
    jobTimeoutSeconds: classification.jobTimeoutSeconds,
    effects: prepared.effects,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(targets.some((target) => target.source === "referenced") ? { referencedTargets: true } : {}),
  });

  const cap = await capAndBudget({
    options: context.options,
    ports: context.ports,
    account: context.account,
    session: sessionHash(context.sessionID),
    now: context.ports.clock.now(),
    estimateBytes: prepared.bytes,
    ...(requested !== undefined ? { requested } : {}),
  });
  if (prepared.bytes > cap.capBytes) {
    throw new BigQueryError(
      "COST_CAP",
      `The estimate is ${prepared.bytes} bytes and the cap is ${cap.capBytes} bytes${cap.remainingBytes !== undefined ? ` (the budget leaves ${cap.remainingBytes})` : ""}`,
      `Narrow the statement, or pass maxBytes up to the account's maxBytesCeiling of ${context.options.maxBytesCeiling} bytes.`,
    );
  }

  const scriptText = script !== undefined ? scriptSummary(script) : undefined;
  const reason = [input.reason, scriptText].filter((value): value is string => value !== undefined && value.length > 0).join(" ");
  const statement: PlannedStatement = {
    sql: input.sql,
    ...(input.params !== undefined ? { params: input.params } : {}),
    project: prepared.project,
    location: prepared.location,
    statementType: prepared.statementType,
    targets,
    estimateBytes: prepared.bytes,
    capBytes: cap.capBytes,
    capEnforceable: classification.capEnforceable,
    jobTimeoutSeconds: classification.jobTimeoutSeconds,
  };
  const output = {
    kind: "plan",
    category: classification.category,
    statementType: prepared.statementType,
    targets: [...new Set(targets.map((target) => target.label))].slice(0, 20),
    referenced: [...new Set([...referencedNames(prepared), ...references.map((reference) => reference.label)])],
    bytes: prepared.bytes,
    accuracy: prepared.accuracy ?? "not reported",
    usd: usdFor(prepared.bytes, context.options),
    capBytes: cap.capBytes,
    bound,
    ...(reason.length > 0 ? { reason } : {}),
    ...(cap.warnings.length > 0 ? { warnings: cap.warnings.map((warning) => ({ ...warning })) } : {}),
  };
  return { prepared, targets, ...(script === undefined ? {} : { script }), classification, statement, output };
}

/** The refusal a planner gives a statement of another class: it names the method that takes it. */
function wrongPlanner(wanted: Category | "uncapped-read", found: Category | "uncapped-read"): BigQueryError {
  const name = found === "uncapped-read" ? "plan_query" : PLANNER[found];
  return new BigQueryError(
    "CATEGORY_MISMATCH",
    `The statement is a ${found} change, and this planner makes ${wanted} plans`,
    `Plan it with ${name}, show the person that preview, then commit with the method it names.`,
  );
}

/** One change's plan: the preview, the committing method and the statement the commit re-checks. */
export async function planChange(category: Category, input: PlanInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const { script, statement, output } = await classifyAndPreview(input, context, category);
  const change: PlannedChange = { category, account: context.account, sessionID: context.sessionID, statement, ...(output.reason !== undefined ? { reason: String(output.reason) } : {}), ...(script === undefined ? {} : { script: { statements: script } }) };
  return {
    method: COMMITTER[category],
    output,
    changes: (output.targets as string[]).slice(0, 20),
    cost: { bytes: statement.estimateBytes, usd: usdFor(statement.estimateBytes, context.options), capBytes: statement.capBytes },
    trust: "untrusted",
    change,
  };
}

/** The uncapped read's plan: committed by `run_query`, with the short time limit a cap-unenforceable read gets. */
export async function planQuery(input: PlanInput, context: HandlerContext): Promise<Record<string, unknown>> {
  const { statement, output } = await classifyAndPreview(input, context, "uncapped-read");
  if (context.options.uncappedReads === "refuse") {
    throw new BigQueryError("CAP_NOT_ENFORCEABLE", "This account refuses reads the byte cap cannot bound", "Narrow the query to native tables without row access policies, or ask the person to set uncappedReads to ask.");
  }
  const query: PlannedRead = { account: context.account, sessionID: context.sessionID, statement };
  return {
    method: "run_query",
    output,
    cost: { bytes: statement.estimateBytes, usd: usdFor(statement.estimateBytes, context.options), capBytes: statement.capBytes },
    trust: "untrusted",
    query,
  };
}
