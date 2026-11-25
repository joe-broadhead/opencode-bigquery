// The JSON Schemas every handler declares. The register checks a call's input and answer against them (contract §9), and
// the agent tools and Code Mode entries show the input. A method's schema never declares `account`: the register adds
// the selector for a method declared `accounts: "optional"`.
import type { JsonSchema } from "@we-the-rebel-alliance/plugin-contract/manifest";

/** No input, and nothing extra. */
export const EMPTY: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

/** A string within a bound, with a description for the model. */
const text = (max: number, description: string): JsonSchema => ({ type: "string", maxLength: max, description });

/** The properties of one object schema, merged in order. */
const fields = (...properties: Readonly<Record<string, JsonSchema>>[]): Record<string, JsonSchema> => Object.assign({}, ...properties);

/** A query parameter map or array; values only, never SQL. */
const params: JsonSchema = {
  description: "Query parameters: an object for @name parameters, an array for ? parameters.",
  anyOf: [
    { type: "object", additionalProperties: true },
    { type: "array", maxItems: 1000, items: {} },
  ],
};

const byteSize: JsonSchema = {
  anyOf: [
    { type: "integer", minimum: 1 },
    { type: "string", pattern: "^\\d+(?:\\.\\d+)?\\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$" },
  ],
};

const project = text(128, "The Google Cloud project; defaults to the account's billing project.");
const location = text(64, "The BigQuery location, such as US, EU or europe-west2; BigQuery chooses when omitted.");

/** A table, view or routine reference the answers carry. */
const TABLE = {
  type: "object",
  properties: { project: { type: "string" }, dataset: { type: "string" }, table: { type: "string" } },
  required: ["project", "dataset", "table"],
  additionalProperties: false,
} as const;

const JOB = {
  type: "object",
  properties: { project: { type: "string" }, jobId: { type: "string" }, location: { type: "string" } },
  required: ["project", "jobId", "location"],
  additionalProperties: false,
} as const;

const COLUMN = {
  type: "object",
  properties: { name: { type: "string" }, type: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
} as const;

const WARNING = {
  type: "object",
  properties: { code: { type: "string" }, message: { type: "string" } },
  required: ["code", "message"],
  additionalProperties: false,
} as const;

/** The fields a query-shaped answer may carry. */
const COST = {
  bytesProcessed: { type: "number" },
  bytesBilled: { type: "number" },
  costUsd: { type: "number" },
  cacheHit: { type: "boolean" },
} as const;

/** The answer of a method that runs a statement, or reports a running one. */
export const QUERY_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["done", "running"] },
    columns: { type: "array", items: COLUMN },
    rows: { type: "array", items: { type: "array", items: {} } },
    totalRows: { type: "integer" },
    returned: { type: "integer" },
    truncated: {
      type: "object",
      properties: { rows: { type: "boolean" }, cells: { type: "boolean" }, bytes: { type: "boolean" } },
      additionalProperties: false,
    },
    ...COST,
    job: JOB,
    next: { type: "string" },
    warnings: { type: "array", items: WARNING },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["state", "trust"],
  additionalProperties: false,
};

/** A commit's answer: the job, its cost, and what the change did. */
export const COMMIT_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["done", "running"] },
    category: { type: "string", enum: ["write", "export", "share", "delete", "admin"] },
    job: JOB,
    affectedRows: { type: "integer" },
    ddlOperation: { type: "string" },
    ...COST,
    next: { type: "string" },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["state", "trust"],
  additionalProperties: false,
};

/** The preview a planner answers; the register publishes these fields beside the planId it mints. */
export const PLAN_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["plan"] },
    category: { type: "string", enum: ["write", "export", "share", "delete", "admin", "uncapped-read"] },
    statementType: { type: "string" },
    targets: { type: "array", items: { type: "string" } },
    referenced: { type: "array", items: { type: "object", additionalProperties: true } },
    bytes: { type: "number" },
    accuracy: { type: "string" },
    usd: { type: "number" },
    capBytes: { type: "number" },
    bound: { type: "string" },
    reason: { type: "string" },
    warnings: { type: "array", items: WARNING },
  },
  required: ["kind", "category", "statementType", "bytes", "usd", "capBytes", "bound"],
  additionalProperties: true,
};

/** Every planner's input: the statement, its parameters, where it runs, the cap and the person's reason. */
export const PLAN_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    sql: { type: "string", minLength: 1, maxLength: 1_048_576, description: "GoogleSQL text, never legacy SQL." },
    params,
    project,
    location,
    maxBytes: { ...byteSize, description: "The commit's byte cap; required for a script." },
    jobTimeoutSeconds: { type: "integer", minimum: 1, maximum: 21_600 },
    reason: text(500, "Why, shown in the preview; required for an admin plan."),
  }),
  required: ["sql"],
  additionalProperties: false,
};

/** `query`'s input: one bounded read. */
export const QUERY_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    sql: { type: "string", minLength: 1, maxLength: 1_048_576, description: "GoogleSQL text that reads: SELECT or ASSERT." },
    params,
    project,
    location,
    maxBytes: { ...byteSize, description: "The job's byte cap, up to the ceiling; 10 GiB by default." },
    maxRows: { type: "integer", minimum: 1, maximum: 500, description: "Rows inline; 50 by default." },
    wait: { type: "integer", minimum: 0, maximum: 240, description: "Seconds to wait for the job; 30 by default." },
    useCache: { type: "boolean" },
  }),
  required: ["sql"],
  additionalProperties: false,
};

/** `estimate`'s input: a dry run of any statement, or of a query. */
export const ESTIMATE_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    sql: { type: "string", minLength: 1, maxLength: 1_048_576, description: "GoogleSQL text to dry-run." },
    params,
    project,
    location,
  }),
  required: ["sql"],
  additionalProperties: false,
};

/** `list`'s input: projects, a project's datasets, or a dataset's tables or routines. */
export const LIST_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project: text(128, "With no project, lists projects; with a project, its datasets."),
    dataset: text(1024, "With a dataset, its tables (or routines with kind)."),
    kind: { type: "string", enum: ["tables", "routines"] },
    filter: text(200, "A substring of the names to keep."),
    details: { type: "boolean", description: "Tables only: rows, bytes and last modified for the first 25." },
    limit: { type: "integer", minimum: 1, maximum: 1000, description: "At most this many; 100 by default." },
    pageToken: text(1024, "The nextPageToken a previous answer carried."),
  }),
  additionalProperties: false,
};

/** `table`'s input: one table's metadata, an optional sample, or its partitions. */
export const TABLE_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project,
    dataset: { type: "string", minLength: 1, maxLength: 1024, description: "The dataset id." },
    table: { type: "string", minLength: 1, maxLength: 1024, description: "The table id." },
    sample: { type: "integer", minimum: 0, maximum: 20, description: "Rows to sample with tabledata.list (free); policy-tagged columns withheld." },
    partitions: { type: "boolean", description: "Per-partition rows and bytes from INFORMATION_SCHEMA.PARTITIONS (billed, at least 10 MB, capped)." },
  }),
  required: ["dataset", "table"],
  additionalProperties: false,
};

/** `search`'s input: words to find in table and column names and descriptions. */
export const SEARCH_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project,
    location,
    query: text(200, "Words to find in table and column names and descriptions."),
    limit: { type: "integer", minimum: 1, maximum: 200 },
  }),
  required: ["query"],
  additionalProperties: false,
};

/** `job`'s input: one job's state and a page of its results. */
export const JOB_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project,
    jobId: { type: "string", minLength: 1, maxLength: 1024, description: "The job id." },
    location,
    wait: { type: "integer", minimum: 0, maximum: 240, description: "Seconds to wait for a running job; 0 by default." },
    maxRows: { type: "integer", minimum: 0, maximum: 500 },
    pageToken: text(1024, "The nextPageToken a previous answer carried."),
  }),
  required: ["jobId"],
  additionalProperties: false,
};

/** `jobs`'s input: this account's recent jobs. */
export const JOBS_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project,
    state: { type: "string", enum: ["done", "running", "pending"] },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    pageToken: text(1024, "The nextPageToken a previous answer carried."),
  }),
  additionalProperties: false,
};

/** `profile`'s input: one aggregate query over a table or a SELECT. */
export const PROFILE_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project,
    location,
    table: text(1100, "project.dataset.table to profile."),
    sql: { type: "string", minLength: 1, maxLength: 1_048_576, description: "A SELECT to profile instead of a table." },
    columns: { type: "array", maxItems: 100, items: { type: "string", maxLength: 300 } },
    samplePercent: { type: "number", minimum: 0.01, maximum: 100, description: "TABLESAMPLE percent; not on row-secured tables." },
    maxBytes: byteSize,
    policyTagged: { type: "string", enum: ["allow"], description: "Profile policy-tagged columns too; only when the plugin's option also allows it." },
  }),
  additionalProperties: false,
  anyOf: [{ required: ["table"] }, { required: ["sql"] }],
};

/** The `bigquery.saved` source's input: one saved query's result as a table. */
export const SAVED_READ_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    source: { type: "string", enum: ["saved"] },
    name: { type: "string", minLength: 1, maxLength: 64, description: "The saved query's name, one saved_list offers." },
    scope: {
      type: "object",
      properties: { queries: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 64 }] } },
      additionalProperties: false,
      description: "The saved queries the person confirmed; a name outside it is refused.",
    },
  }),
  required: ["name"],
  additionalProperties: false,
};

/** `saved_list`'s input: the bind-time list of saved queries. */
export const SAVED_LIST_INPUT: JsonSchema = {
  type: "object",
  properties: fields({ source: { type: "string", enum: ["saved", "bigquery.saved"] } }),
  additionalProperties: false,
};

/** `probe`'s input: which source's account to name (nothing else). */
export const PROBE_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    source: { type: "string", enum: ["jobs", "saved", "bigquery.jobs", "bigquery.saved"] },
  }),
  additionalProperties: false,
};

/** `cancel`'s input: one job this account started. */
export const CANCEL_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project,
    jobId: { type: "string", minLength: 1, maxLength: 1024, description: "The job id." },
    location,
  }),
  required: ["jobId"],
  additionalProperties: false,
};

/** `save`'s input: one finished query's rows, to a local file. */
export const SAVE_INPUT: JsonSchema = {
  type: "object",
  properties: fields({
    project,
    jobId: { type: "string", minLength: 1, maxLength: 1024, description: "The finished job whose rows to write." },
    location,
    path: text(4096, "The file to write: inside the project, under resultsDir or an allowedRoot."),
    format: { type: "string", enum: ["csv", "jsonl", "parquet"] },
    overwrite: { type: "boolean" },
  }),
  required: ["jobId", "path", "format"],
  additionalProperties: false,
};

/** The saved snapshot's answer: the registry's `table` shape, its cost and asOf. */
export const SNAPSHOT_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        columns: {
          type: "array",
          maxItems: 8,
          items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" } }, required: ["key", "label"], additionalProperties: false },
        },
        rows: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: true } },
      },
      required: ["columns", "rows"],
      additionalProperties: false,
    },
    asOf: { type: "string" },
    cost: { type: "object", additionalProperties: true },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["data", "asOf", "trust"],
  additionalProperties: false,
};

/** `list`'s answer: the items, the next page and the untrusted marker. */
export const LIST_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "object", additionalProperties: true } },
    nextPageToken: { type: "string" },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["items", "trust"],
  additionalProperties: false,
};

/** `table`'s answer: the metadata, and optionally a sample or the partitions. */
export const TABLE_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    table: TABLE,
    type: { type: "string" },
    columns: { type: "array", items: { type: "object", additionalProperties: true } },
    partitioning: { type: "object", additionalProperties: true },
    clustering: { type: "array", items: { type: "string" } },
    rows: { type: "number" },
    bytes: { type: "number" },
    modified: { type: "string" },
    viewSql: { type: "string" },
    sample: {},
    withheld: { type: "array", items: { type: "string" } },
    partitions: { type: "array", items: { type: "object", additionalProperties: true } },
    warnings: { type: "array", items: WARNING },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["trust"],
  additionalProperties: false,
};

/** `search`'s answer: the matches, and which read found them. */
export const SEARCH_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          table: TABLE,
          column: { type: "string" },
          where: { type: "string", enum: ["name", "description"] },
        },
        required: ["table", "where"],
        additionalProperties: false,
      },
    },
    via: { type: "string", enum: ["region", "dataset", "names"] },
    ...COST,
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["matches", "trust"],
  additionalProperties: false,
};

/** `estimate`'s answer: the dry run's numbers. */
export const ESTIMATE_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    statementType: { type: "string" },
    category: { type: "string" },
    referenced: {
      type: "object",
      properties: {
        tables: { type: "array", items: { type: "string" } },
        views: { type: "array", items: { type: "string" } },
        routines: { type: "array", items: { type: "string" } },
        propertyGraphs: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    bytes: { type: "number" },
    accuracy: { type: "string" },
    costUsd: { type: "number" },
    capEnforceable: { type: "boolean" },
    whyNot: { type: "string" },
    schema: { type: "array", items: COLUMN },
    hints: { type: "array", items: { type: "string" } },
    location: { type: "string" },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["statementType", "bytes", "trust"],
  additionalProperties: false,
};

/** `job`'s answer: the state, the job and a page of its rows. */
export const JOB_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    job: JOB,
    jobState: { type: "string" },
    statementType: { type: "string" },
    slotMs: { type: "number" },
    ...COST,
    columns: { type: "array", items: COLUMN },
    rows: { type: "array", items: { type: "array", items: {} } },
    returned: { type: "integer" },
    nextPageToken: { type: "string" },
    truncated: { type: "object", additionalProperties: true },
    next: { type: "string" },
    warnings: { type: "array", items: WARNING },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["job", "jobState", "trust"],
  additionalProperties: false,
};

/** `jobs`'s answer: this account's recent jobs. */
export const JOBS_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    jobs: { type: "array", items: { type: "object", additionalProperties: true } },
    nextPageToken: { type: "string" },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["jobs", "trust"],
  additionalProperties: false,
};

/** `profile`'s answer: one entry per profiled column. */
export const PROFILE_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    columns: { type: "array", items: { type: "object", additionalProperties: true } },
    ...COST,
    job: JOB,
    warnings: { type: "array", items: WARNING },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["columns", "trust"],
  additionalProperties: false,
};

/** `cancel`'s answer: the job's state after the cancel. */
export const CANCEL_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    job: JOB,
    jobState: { type: "string" },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["job", "trust"],
  additionalProperties: false,
};

/** `save`'s answer: the file it wrote and what the rows were. */
export const SAVE_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    rows: { type: "integer" },
    bytes: { type: "integer" },
    sha256: { type: "string" },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["path", "trust"],
  additionalProperties: false,
};
