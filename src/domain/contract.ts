/**
 * The tools' contract: every input and output schema, and the result envelope they share (design §4, §5.6, §7, §10).
 * The registry registers these schemas, and the packages fill in the handlers that produce them, so a handler's
 * result is checked against the same schema the model and scripts see.
 *
 * Every result is `{ state, …, error?, message?, next?, reason?, googleError?, warnings? }`:
 * - `state` is `done`, `running`, or the error's state (`refused`, `failed`, `cancelled`);
 * - `message` and `next` are built from codes and validated identifiers only;
 * - Google's text goes into `googleError` with `trust: "untrusted"`, and any data Google returns sits under a result
 *   that carries `trust: "untrusted"`.
 */
import * as z from "zod"
import { CATEGORIES } from "./actions.js"
import { ERROR_CODES, NEEDS_PLAN_REASONS, WARNING_CODES } from "./errors.js"

// ── Shared pieces ────────────────────────────────────────────────────────

/** An account alias: a short name, as `bigquery-<alias>` names its sign-in. */
export const ALIAS = /^[a-z][a-z0-9-]{0,30}$/
/** Google's project ids (6 to 30 characters; a domain-scoped `example.com:proj` too), dataset ids and table ids. */
export const PROJECT_ID = /^(?:[a-z][a-z0-9.-]{0,61}[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/
export const DATASET_ID = /^[A-Za-z0-9_]{1,1024}$/
/** Table ids may use flexible names; they are passed to Google as given and shown only as validated identifiers. */
export const TABLE_ID = /^[^\u0000-\u001f`]{1,1024}$/
export const JOB_ID = /^[A-Za-z0-9_-]{1,1024}$/
export const LOCATION = /^[A-Za-z0-9-]{2,64}$/
/** A byte size: a whole number of bytes, or a number and a unit (`10GiB`, `512MiB`). */
export const BYTE_SIZE = /^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/

export const account = z.string().regex(ALIAS, "use a configured account alias").optional().describe("The account alias; omit with one account")
export const project = z.string().regex(PROJECT_ID, "use a Google Cloud project id").optional().describe("The project; defaults to the account's billing project")
export const location = z.string().regex(LOCATION).optional().describe("The location, such as US, EU or europe-west2; inferred when omitted")
export const byteSize = z.union([z.number().int().positive(), z.string().regex(BYTE_SIZE)])
export const sql = z.string().min(1).max(1_048_576).describe("GoogleSQL text; never legacy SQL")
/** Query parameters: named (`@name`) as an object, or positional (`?`) as an array. Values only, never SQL. */
export const params = z
  .union([z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.unknown()), z.array(z.unknown()).max(1000)])
  .optional()
  .describe("Query parameters: an object for @name parameters, an array for ? parameters")
export const planId = z.string().regex(/^plan_[A-Za-z0-9_-]{16,64}$/)

/**
 * What the model reads about running an uncapped-read plan. Under Jelly's Allowed the run-time ask is not shown (D165),
 * so the absence of a prompt is never the user's consent: the model gets the go-ahead in the conversation first.
 */
export const UNCAPPED_PLAN_ID = "Run an uncapped-read plan instead of sql. The user may not be asked first (Jelly's Allowed): get the user's go-ahead in the conversation before you run it."

export const STATES = ["done", "running", "refused", "failed", "cancelled"] as const

export const GoogleErrorSchema = z.strictObject({
  reason: z.string().max(64).optional(),
  location: z.string().max(256).optional(),
  message: z.string().max(500).optional(),
  trust: z.literal("untrusted"),
})

export const WarningSchema = z.strictObject({ code: z.enum(WARNING_CODES as unknown as [string, ...string[]]), message: z.string() })

/** The fields every result may carry. A tool's own fields are optional, because a refusal carries none of them. */
const envelope = {
  state: z.enum(STATES),
  error: z.enum(ERROR_CODES as unknown as [string, ...string[]]).optional(),
  message: z.string().optional(),
  next: z.string().optional(),
  reason: z.enum(NEEDS_PLAN_REASONS).optional(),
  retryAfterSec: z.number().nonnegative().optional(),
  googleError: GoogleErrorSchema.optional(),
  warnings: z.array(WarningSchema).optional(),
}

const result = <S extends z.ZodRawShape>(shape: S) => z.object({ ...envelope, ...shape })

const untrusted = z.literal("untrusted")
const tableRef = z.strictObject({ project: z.string(), dataset: z.string(), table: z.string() })
const jobRef = z.strictObject({ project: z.string(), jobId: z.string(), location: z.string() })
const accuracy = z.enum(["PRECISE", "UPPER_BOUND", "LOWER_BOUND", "UNKNOWN"])
const category = z.enum(CATEGORIES)
const cell = z.unknown()
const truncated = z.strictObject({ rows: z.boolean(), cells: z.boolean(), bytes: z.boolean() })
const cost = { bytesProcessed: z.number().optional(), bytesBilled: z.number().optional(), costUsd: z.number().optional(), cacheHit: z.boolean().optional() }

// ── The nineteen tools ───────────────────────────────────────────────────

export const StatusInput = z.strictObject({
  account,
  include: z.array(z.enum(["jobs", "iam", "spend"])).max(3).optional().describe("Extra checks: running jobs, the IAM check, spend reconciled with Google"),
})
export const StatusOutput = result({
  accounts: z
    .array(
      z.object({
        alias: z.string(),
        mode: z.enum(["interactive", "adc", "token"]),
        level: z.enum(["read", "write"]),
        billingProject: z.string().optional(),
        location: z.string().optional(),
        binding: z.enum(["bound", "unbound"]).optional(),
        disclosure: z.string().optional(),
      }),
    )
    .optional(),
  caps: z.object({ maxBytesBilled: z.number(), maxBytesCeiling: z.number() }).optional(),
  spend: z.object({ todayBytes: z.number(), sessionBytes: z.number(), todayUsd: z.number() }).optional(),
})

export const ListInput = z.strictObject({
  account,
  project: z.string().regex(PROJECT_ID).optional().describe("With no project, lists projects; with a project, its datasets"),
  dataset: z.string().regex(DATASET_ID).optional().describe("With a dataset, its tables (or routines with kind)"),
  kind: z.enum(["tables", "routines"]).optional(),
  filter: z.string().max(200).optional().describe("A substring of the names to keep"),
  details: z.boolean().optional().describe("Tables only: rows, bytes and last modified for the first 25"),
  limit: z.number().int().min(1).max(1000).optional().describe("At most this many; 100 by default"),
  pageToken: z.string().max(1024).optional(),
})
export const ListOutput = result({
  items: z.array(z.record(z.string(), z.unknown())).optional(),
  nextPageToken: z.string().optional(),
  trust: untrusted.optional(),
})

export const TableInput = z.strictObject({
  account,
  project,
  dataset: z.string().regex(DATASET_ID),
  table: z.string().regex(TABLE_ID),
  sample: z.number().int().min(0).max(20).optional().describe("Rows to sample with tabledata.list (free); policy-tagged columns withheld"),
  partitions: z.boolean().optional().describe("Per-partition rows and bytes from INFORMATION_SCHEMA.PARTITIONS (billed, at least 10 MB, capped)"),
})
export const TableOutput = result({
  table: tableRef.optional(),
  type: z.string().optional(),
  columns: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string().optional(), description: z.string().optional(), policyTag: z.boolean().optional() })).optional(),
  partitioning: z.record(z.string(), z.unknown()).optional(),
  clustering: z.array(z.string()).optional(),
  rows: z.number().optional(),
  bytes: z.number().optional(),
  modified: z.string().optional(),
  viewSql: z.string().max(2000).optional(),
  sample: z.union([z.array(z.array(cell)), z.strictObject({ unavailable: z.string() })]).optional(),
  withheld: z.array(z.string()).optional(),
  partitions: z.array(z.record(z.string(), z.unknown())).optional(),
  trust: untrusted.optional(),
})

export const SearchInput = z.strictObject({
  account,
  project,
  location,
  query: z.string().min(1).max(200).describe("Words to find in table and column names and descriptions"),
  limit: z.number().int().min(1).max(200).optional(),
})
export const SearchOutput = result({
  matches: z.array(z.object({ table: tableRef, column: z.string().optional(), where: z.enum(["name", "description"]) })).optional(),
  via: z.enum(["region", "dataset", "names"]).optional(),
  ...cost,
  trust: untrusted.optional(),
})

export const EstimateInput = z.strictObject({ account, sql, params, project, location })
export const EstimateOutput = result({
  statementType: z.string().optional(),
  category: z.union([z.literal("read"), category]).optional(),
  referenced: z
    .object({ tables: z.array(z.string()), views: z.array(z.string()), routines: z.array(z.string()), propertyGraphs: z.array(z.string()) })
    .optional(),
  bytes: z.number().optional(),
  accuracy: accuracy.optional(),
  costUsd: z.number().optional(),
  capEnforceable: z.boolean().optional(),
  whyNot: z.string().optional(),
  schema: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  hints: z.array(z.string()).optional(),
  location: z.string().optional(),
})

export const QueryInput = z
  .strictObject({
    account,
    sql: sql.optional(),
    params,
    project,
    location,
    maxBytes: byteSize.optional().describe("The job's byte cap, up to the ceiling; 10 GiB by default"),
    maxRows: z.number().int().min(1).max(500).optional().describe("Rows inline; 50 by default"),
    wait: z.number().int().min(0).max(240).optional().describe("Seconds to wait for the job; 30 by default"),
    useCache: z.boolean().optional(),
    planId: planId.optional().describe(UNCAPPED_PLAN_ID),
  })
  .refine((input) => (input.planId === undefined) !== (input.sql === undefined), { message: "pass sql, or planId alone" })
  .refine((input) => input.planId === undefined || Object.keys(input).every((key) => key === "planId" || key === "account"), {
    message: "planId takes no other input",
  })
export const QueryOutput = result({
  columns: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  rows: z.array(z.array(cell)).optional(),
  totalRows: z.number().optional(),
  returned: z.number().optional(),
  truncated: truncated.optional(),
  ...cost,
  job: jobRef.optional(),
  trust: untrusted.optional(),
})

export const JobInput = z.strictObject({
  account,
  project,
  jobId: z.string().regex(JOB_ID),
  location,
  wait: z.number().int().min(0).max(240).optional(),
  maxRows: z.number().int().min(0).max(500).optional(),
  pageToken: z.string().max(1024).optional(),
})
export const JobOutput = result({
  job: jobRef.optional(),
  jobState: z.enum(["PENDING", "RUNNING", "DONE"]).optional(),
  statementType: z.string().optional(),
  slotMs: z.number().optional(),
  ...cost,
  columns: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  rows: z.array(z.array(cell)).optional(),
  nextPageToken: z.string().optional(),
  truncated: truncated.optional(),
  trust: untrusted.optional(),
})

export const JobsInput = z.strictObject({
  account,
  project,
  state: z.enum(["done", "running", "pending"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  pageToken: z.string().max(1024).optional(),
})
export const JobsOutput = result({
  jobs: z
    .array(
      z.object({
        job: jobRef,
        jobState: z.string(),
        statementType: z.string().optional(),
        created: z.string().optional(),
        bytesBilled: z.number().optional(),
        labels: z.record(z.string(), z.string()).optional(),
        sql: z.string().max(200).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  trust: untrusted.optional(),
})

export const ProfileInput = z
  .strictObject({
    account,
    project,
    location,
    table: z.string().max(1100).optional().describe("project.dataset.table to profile"),
    sql: sql.optional().describe("A SELECT to profile instead of a table"),
    columns: z.array(z.string().max(300)).max(100).optional(),
    samplePercent: z.number().min(0.01).max(100).optional().describe("TABLESAMPLE percent; not on row-secured tables"),
    maxBytes: byteSize.optional(),
    policyTagged: z.literal("allow").optional().describe("Profile policy-tagged columns too"),
  })
  .refine((input) => (input.table === undefined) !== (input.sql === undefined), { message: "pass table or sql" })
export const ProfileOutput = result({
  columns: z.array(z.record(z.string(), z.unknown())).optional(),
  ...cost,
  job: jobRef.optional(),
  trust: untrusted.optional(),
})

export const PlanInput = z.strictObject({
  account,
  sql,
  params,
  project,
  location,
  maxBytes: byteSize.optional().describe("The commit's byte cap; required for a script"),
  jobTimeoutSeconds: z.number().int().min(1).max(21_600).optional(),
  reason: z.string().min(1).max(500).optional().describe("Why; required for an admin plan, shown in the preview"),
})
export const PlanOutput = result({
  planId: planId.optional(),
  category: category.optional(),
  /** False on a Read account for every category but uncapped-read: the preview shows, a commit is refused. */
  committable: z.boolean().optional(),
  commitWith: z.string().optional(),
  preview: z
    .object({
      statementType: z.string(),
      targets: z.array(z.string()),
      referenced: z.array(z.record(z.string(), z.unknown())),
      bytes: z.number(),
      accuracy: z.string(),
      usd: z.number(),
      capBytes: z.number(),
      bound: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  expiresAt: z.string().optional(),
})

/** The `bigquery.jobs` source's input: the source contract's `EventsListInput`. */
export const EventsListInput = z.strictObject({
  source: z.literal("jobs").optional(),
  account,
  since: z.string().max(64).optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  scope: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
})
/** The source contract's `EventsListResult`; package E fills it and the conformance kit checks it. */
export const EventsListOutput = z.looseObject({ state: z.enum(STATES).optional(), source: z.string().optional(), events: z.array(z.unknown()).optional() })

/** The `bigquery.saved` source's input: one saved query, by name. */
export const SavedReadInput = z.strictObject({
  source: z.literal("saved").optional(),
  account,
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
})
/** The source contract's `table` snapshot; package E fills it. */
export const SavedReadOutput = z.looseObject({ state: z.enum(STATES).optional() })

export const SaveInput = z.strictObject({
  account,
  project,
  jobId: z.string().regex(JOB_ID),
  location,
  path: z.string().min(1).max(4096).describe("The file to write: inside the project, or under allowedRoots"),
  format: z.enum(["csv", "jsonl", "parquet"]),
  overwrite: z.boolean().optional(),
})
export const SaveOutput = result({
  path: z.string().optional(),
  rows: z.number().optional(),
  bytes: z.number().optional(),
  sha256: z.string().optional(),
  charts: z.object({ path: z.string(), format: z.string(), rows: z.number(), fitsCharts: z.boolean() }).optional(),
})

export const CancelInput = z.strictObject({ account, project, jobId: z.string().regex(JOB_ID), location })
export const CancelOutput = result({ job: jobRef.optional(), jobState: z.string().optional(), billed: z.literal("unknown").optional() })

/** Every commit tool takes the plan's id alone. */
export const CommitInput = z.strictObject({ planId })
export const CommitOutput = result({
  category: category.optional(),
  job: jobRef.optional(),
  affectedRows: z.number().optional(),
  ddlOperation: z.string().optional(),
  ...cost,
})

/** The bind step's list of saved queries, with their SQL (untrusted, cut to 500) and estimates. */
export const SavedListInput = z.strictObject({ account })
export const SavedListOutput = result({
  queries: z.array(z.object({ name: z.string(), sql: z.string().max(500), bytes: z.number().optional(), costUsd: z.number().optional() })).optional(),
  trust: untrusted.optional(),
})

/** The source probe: the identity, with no BigQuery call. */
export const ProbeInput = z.strictObject({ account })
export const ProbeOutput = z.looseObject({ owner: z.object({ id: z.string(), label: z.string().optional() }).optional(), verified: z.literal(false).optional() })

/** Every entry's schemas, by name (src/domain/actions.ts). */
export const SCHEMAS = {
  status: { input: StatusInput, output: StatusOutput, description: "Accounts, levels, caps and spend, and what to do next. No Google call unless include asks." },
  list: { input: ListInput, output: ListOutput, description: "Projects; a project's datasets; a dataset's tables or routines. Free." },
  table: { input: TableInput, output: TableOutput, description: "A table's schema, partitioning, clustering, size and view SQL; an optional small sample. Free unless partitions." },
  search: { input: SearchInput, output: SearchOutput, description: "Find tables and columns by name or description. Billed at least 10 MB per view read." },
  estimate: { input: EstimateInput, output: EstimateOutput, description: "Dry-run SQL: type, referenced objects, bytes, cost, and whether the byte cap bounds it. Free." },
  query: { input: QueryInput, output: QueryOutput, description: "Run a read under a byte cap, after a dry run; or, with the user's go-ahead, run an uncapped-read plan by planId. Billed." },
  job: { input: JobInput, output: JobOutput, description: "One job's state, bytes and errors, and a page of its results. Free." },
  jobs: { input: JobsInput, output: JobsOutput, description: "This account's recent jobs. Free." },
  profile: { input: ProfileInput, output: ProfileOutput, description: "One aggregate query that profiles a table or a SELECT. Billed, capped." },
  plan: { input: PlanInput, output: PlanOutput, description: "Dry-run a change, or a read that needs one, and return a preview and a single-use planId. Free." },
  events_list: { input: EventsListInput, output: EventsListOutput, description: "The bigquery.jobs source: your finished jobs, oldest first, from a cursor. Free." },
  saved_read: { input: SavedReadInput, output: SavedReadOutput, description: "The bigquery.saved source: one saved query's result as a table. Billed, capped." },
  save: { input: SaveInput, output: SaveOutput, description: "Write a finished query's results to a local CSV, JSONL or Parquet file. Free." },
  cancel: { input: CancelInput, output: CancelOutput, description: "Cancel a running job this account started." },
  write: { input: CommitInput, output: CommitOutput, description: "Commit a write plan by its planId. Billed." },
  export: { input: CommitInput, output: CommitOutput, description: "Commit an export plan by its planId. Billed, capped." },
  share: { input: CommitInput, output: CommitOutput, description: "Commit a share plan (grants, row and data policies) by its planId." },
  delete: { input: CommitInput, output: CommitOutput, description: "Commit a delete plan by its planId: deletes, drops, replaces, scripts. Billed, capped." },
  admin: { input: CommitInput, output: CommitOutput, description: "Commit an admin plan (capacity, reservations, connections) by its planId." },
  saved_list: { input: SavedListInput, output: SavedListOutput, description: "Your saved queries with their SQL and estimates, for a source's set-up. Free." },
  probe: { input: ProbeInput, output: ProbeOutput, description: "The signed-in account, for sources. No BigQuery call." },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType; description: string }>

export type ToolName = keyof typeof SCHEMAS
export type InputOf<N extends ToolName> = z.output<(typeof SCHEMAS)[N]["input"]>
export type OutputOf<N extends ToolName> = z.output<(typeof SCHEMAS)[N]["output"]>
