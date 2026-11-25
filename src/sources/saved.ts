/**
 * `bigquery.saved`, the snapshot source (design §10), and the bind-time `saved_list` its `scope.suggest` names.
 *
 * - a read runs the full read path (`prepareRead` + `runRead`, package C) over the query text the person confirmed in
 *   the plugin's `savedQueries` option: dry run, statement type, expansion, fence, policy tags, cap and cost, run,
 *   results — nothing about a source read is weaker than a query an agent asks for;
 * - a query whose cost the cap cannot bound, or that has external effects, is refused (`INPUT_INVALID`): sources never
 *   plan and never ask a person mid-read;
 * - a query the cache cannot serve (a non-deterministic function: `CURRENT_*`, `RAND`, `GENERATE_UUID`, `SESSION_USER`)
 *   is refused unless `allowUncached: true`, because every uncached read bills;
 * - the answer is the registry's `table`: at most 8 columns keyed `c1`…`c8` with the query's names as labels, at most
 *   100 rows, each cell a string, number, boolean or null; more is `TOO_LARGE`, never silently cut;
 * - `saved_list` dry-runs each query with `jobs.query` (`dryRun: true`, free, the bind-time estimate) so the person sees
 *   the SQL and its estimate, not just its name.
 */
import { BigQueryError } from "../domain/errors.js"
import { usdFor } from "../guards/cost.js"
import { prepareRead, readContext, runRead } from "../guards/read.js"
import { settingsOf } from "../guards/settings.js"
import { sourceError } from "./errors.js"
import type { SourceDeps } from "./events.js"

/**
 * The operations the source declares: `saved_read` carries them, and the register asserts its own action
 * (`bigquery.saved_read`) on each `<account>:<operation>` before the handler runs.
 */
export const SAVED_OPERATIONS: readonly string[] = [
  "bigquery.jobs.getQueryResults",
  "bigquery.jobs.query",
  "bigquery.routines.get",
  "bigquery.rowAccessPolicies.list",
  "bigquery.tabledata.list",
  "bigquery.tables.get",
]

const MAX_COLUMNS = 8
const MAX_ROWS = 100
const LABEL = 40
const CELL = 200
/** At most this many bytes billed by one read; the design's 1 GiB default (design §10, M9). */
export const DEFAULT_MAX_BYTES = 2 ** 30
/** The functions whose value changes per call: a query with one cannot be served from BigQuery's cache. */
const NON_CACHEABLE = /\bCURRENT_(?:DATE|DATETIME|TIME|TIMESTAMP)\b|\bRAND\s*\(|\bGENERATE_UUID\s*\(|\bSESSION_USER\b/i

/** The registry's `table` output: keys `c1`…, labels the query's names, typed cells. */
export interface TableData {
  readonly columns: readonly { readonly key: string; readonly label: string }[]
  readonly rows: readonly Record<string, string | number | boolean | null>[]
}

/** A snapshot, as the contract's `read` receives it. */
export interface SnapshotAnswer {
  readonly data: TableData
  readonly asOf: string
  readonly cost: { readonly units: readonly { readonly per: string; readonly count: number }[]; readonly usd: number }
  readonly trust: "untrusted"
}

const nameOf = (name: string) => (/^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "that name")

/** One cell as the registry's table takes it; strings and nested values are cut at 200 characters. */
function cell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null")
  return text.length > CELL ? `${text.slice(0, CELL - 1)}…` : text
}

/** The bind step's one operation: a free `jobs.query` dry run per saved query. */
export const SUGGEST_OPERATIONS: readonly string[] = ["bigquery.jobs.queryEstimate"]

/** Whether a name is inside the confirmed scope's `queries`; no scope is the whole source. */
function inScope(name: string, scope: Readonly<Record<string, string | readonly string[]>> | undefined): boolean {
  if (scope === undefined) return true
  const queries = scope["queries"]
  if (queries === undefined) return true
  return (typeof queries === "string" ? [queries] : queries).includes(name)
}

/**
 * `saved_read`: one saved query, through the read path, as the registry's table. A consumer sends the confirmed scope
 * with the read (contract L2: `{ source, account, scope, params }`); a name outside its `queries` is refused before
 * anything runs.
 */
export async function savedRead(deps: SourceDeps, name: string, scope?: Readonly<Record<string, string | readonly string[]>>): Promise<SnapshotAnswer> {
  if (!inScope(name, scope)) {
    throw sourceError("INPUT_INVALID", `The saved query ${nameOf(name)} is outside the queries this read was confirmed for.`, "Read one of the queries the source's scope names, or confirm the source again with this one.")
  }
  const saved = deps.options.savedQueries[name]
  if (saved === undefined) {
    throw sourceError(
      "INPUT_INVALID",
      `The plugin's savedQueries option has no query named ${nameOf(name)}.`,
      "Choose one of the names saved_list offers, or add it to the plugin's savedQueries option.",
    )
  }
  if (saved.allowUncached !== true && NON_CACHEABLE.test(saved.sql)) {
    throw sourceError(
      "INPUT_INVALID",
      `The saved query ${nameOf(name)} calls a function BigQuery cannot cache, such as CURRENT_TIMESTAMP, so every read bills.`,
      "Set allowUncached: true on the saved query if that is intended, or remove the function.",
    )
  }
  const rc = readContext({ ports: deps.ports, options: deps.options, account: deps.account, sessionID: deps.sessionID, signal: deps.signal, via: "saved_read" })
  const prepared = await prepareRead(
    rc,
    {
      sql: saved.sql,
      ...(saved.project !== undefined ? { project: saved.project } : {}),
      ...(saved.location !== undefined ? { location: saved.location } : {}),
      maxBytes: saved.maxBytes ?? DEFAULT_MAX_BYTES,
      useCache: true,
    },
    "read",
  )
  const run = await runRead(rc, prepared, { maxRows: MAX_ROWS + 1, waitSeconds: 30 })
  if (run.state === "running") {
    throw sourceError("UNAVAILABLE", `The saved query ${nameOf(name)} did not finish within 30 seconds.`, "Make the query cheaper, or run it in the Google Cloud console.")
  }
  if (run.state === "failed") {
    throw new BigQueryError(run.failure!.code, run.failure!.detail, run.failure!.next)
  }
  if (run.inline === false) {
    throw sourceError(
      "INPUT_INVALID",
      `The saved query ${nameOf(name)} reads a policy-tagged table or a dataset the account keeps out of results, so its rows cannot be read as a source.`,
      "Change the query to read native tables without policy tags, or read it with query and save the result.",
    )
  }
  const columns = run.columns ?? []
  const rows = run.rows ?? []
  const total = run.totalRows ?? rows.length
  if (columns.length > MAX_COLUMNS) {
    throw sourceError("TOO_LARGE", `The saved query ${nameOf(name)} returns ${columns.length} columns, and this source reads at most ${MAX_COLUMNS}.`, `Change the query to return at most ${MAX_COLUMNS} columns.`)
  }
  if (total > MAX_ROWS || rows.length > MAX_ROWS) {
    throw sourceError("TOO_LARGE", `The saved query ${nameOf(name)} returns more than ${MAX_ROWS} rows, and this source reads at most ${MAX_ROWS}.`, `Change the query to return at most ${MAX_ROWS} rows.`)
  }
  const keys = columns.map((_, index) => `c${index + 1}`)
  const data: TableData = {
    columns: columns.map((column, index) => ({ key: keys[index]!, label: cut(column.name, LABEL) })),
    rows: rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, cell(row[index])]))),
  }
  return {
    data,
    asOf: new Date(deps.ports.clock.now()).toISOString(),
    cost: { units: [{ per: "tib", count: Math.floor(run.bytesBilled / 2 ** 40) }], usd: run.usd },
    trust: "untrusted",
  }
}

/** At most `max` characters, ending in `…` when cut (the labels a person confirms are short). */
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** A price as a person reads it. */
const formatUsd = (value: number) => `$${value.toFixed(value < 0.01 ? 4 : 2)}`;

/** One option `saved_list` offers: the name, and the query it runs. */
export interface SavedOption {
  readonly id: string
  readonly label: string
}

/** What `saved_list` answers: the contract's `options`, each with its SQL and free estimate in the label. */
export interface SavedListAnswer {
  readonly options: readonly SavedOption[];
}

/** The bind-time suggestion: each saved query with its SQL and a free `jobs.query` dry run's estimate. */
export async function savedList(deps: SourceDeps): Promise<SavedListAnswer> {
  const settings = settingsOf(deps.options, deps.account);
  const options: SavedOption[] = [];
  for (const [name, saved] of Object.entries(deps.options.savedQueries).slice(0, 64)) {
    const project = saved.project ?? settings.billingProject;
    let estimate: { readonly statementType?: string; readonly totalBytesProcessed?: number } | undefined;
    if (project !== undefined) {
      try {
        estimate = await deps.ports.bigquery.estimate(
          {
            account: deps.account,
            project,
            sql: saved.sql,
            ...(saved.location !== undefined ? { location: saved.location } : settings.location !== undefined ? { location: settings.location } : {}),
          },
          deps.signal,
        );
      } catch (error) {
        // A query with a syntax error is still listed, so the person can see and fix it: the estimate is omitted.
        if (!(error instanceof BigQueryError)) throw error;
      }
    }
    const bytes = estimate?.totalBytesProcessed;
    const cost = bytes !== undefined ? ` — ${formatUsd(usdFor(bytes, deps.options))}` : "";
    options.push({ id: name, label: cut(`${name}: ${saved.sql.replace(/\s+/g, " ") || "(no SQL)"}${cost}`, 190) });
  }
  return { options };
}
