/**
 * The one table of what the plugin asserts: every tool's action, every tools RPC method's action and every run-time
 * ask. The registry (`src/registry.ts`), the default rules (`src/permissions.ts`), the package declaration and the
 * tools RPC all come from it, and tests keep them equal: an action the plugin asserts is an action it declares, and a
 * read is declared read-only, so an access level that allows reads lets it run (an undeclared read would fall under
 * the namespace's change effect).
 *
 * Actions are `bigquery.<name>`; the model sees the tool `bigquery_<name>`. Operations name Google's REST methods,
 * with one stated exception: a verified read query job is `bigquery.jobs.query`, whether `jobs.query` or
 * `jobs.insert` makes it, and a dry run is `bigquery.jobs.queryEstimate`. Every change asserts `bigquery.jobs.insert`.
 *
 * This module imports nothing, so scripts can load it directly.
 */

export const NAMESPACE = "bigquery"

/** The source contract's method classes. Only `read` entries become tools RPC methods. */
export type ActionClass = "read" | "write" | "export" | "destructive"

/** The package that builds an entry (docs/ownership.md). */
export type Package = "A" | "B" | "C" | "D" | "E" | "F"

/** A plan's category, and the tool that commits it. */
export const CATEGORIES = ["uncapped-read", "write", "export", "share", "delete", "admin"] as const
export type Category = (typeof CATEGORIES)[number]

export interface ActionEntry {
  /** The name without the namespace: the tool `bigquery_<name>`, the method `<name>`. */
  readonly name: string
  /** The permission action: `bigquery.<name>`. */
  readonly action: string
  /** `tool`: a model tool (and, for a read, a method). `method`: a tools RPC method only, declared for the permission rules. */
  readonly kind: "tool" | "method"
  /** True when it changes nothing anywhere: the declaration's `readOnly`, and allowed at every access. */
  readonly readOnly: boolean
  readonly class: ActionClass
  /**
   * The operation its first assert names, as the resource `<account>:<operation>`; `local` asserts `*` (no account,
   * no Google call); `input` resolves from the input (`bigquery_list`: projects, datasets, tables or routines;
   * `bigquery_table`: the table, a sample or its partitions).
   */
  readonly operation: string | "local" | "input"
  /** For a tools RPC method with a resolver: what the resolver may name. `any` only for `plan`, which dry-runs a change. */
  readonly resourceKind?: "read" | "any"
  /** The category a commit tool commits. */
  readonly commits?: Exclude<Category, "uncapped-read">
  /** Whether "Always" may be saved for its asks; `false` asks every time (delete). */
  readonly savable?: boolean
  readonly owner: Package
  /** The declaration's note on the tool (at most 200 characters), where the name alone does not say enough. */
  readonly note?: string
}

const entry = (name: string, fields: Omit<ActionEntry, "name" | "action">): ActionEntry => ({ name, action: `${NAMESPACE}.${name}`, ...fields })

/** The nineteen tools, then the two method-only reads. Order: the docs' order (§4 of the design). */
export const ACTIONS: readonly ActionEntry[] = [
  entry("status", { kind: "tool", readOnly: true, class: "read", operation: "local", owner: "F" }),
  entry("list", { kind: "tool", readOnly: true, class: "read", operation: "input", owner: "C" }),
  entry("table", { kind: "tool", readOnly: true, class: "read", operation: "input", owner: "C" }),
  entry("search", { kind: "tool", readOnly: true, class: "read", operation: "bigquery.jobs.query", owner: "C" }),
  entry("estimate", { kind: "tool", readOnly: true, class: "read", operation: "bigquery.jobs.queryEstimate", owner: "C" }),
  entry("query", {
    kind: "tool",
    readOnly: true,
    class: "read",
    operation: "bigquery.jobs.query",
    owner: "C",
    // The card's note: whether this ask prompts is the access rules' decision.
    note: "Runs SELECT and ASSERT under a byte cap. One the cap cannot bound runs from a plan: under Allowed without asking, limited to 120 seconds and your budget if set; otherwise you are asked first",
  }),
  entry("job", { kind: "tool", readOnly: true, class: "read", operation: "bigquery.jobs.get", owner: "C" }),
  entry("jobs", { kind: "tool", readOnly: true, class: "read", operation: "bigquery.jobs.list", owner: "C" }),
  entry("profile", { kind: "tool", readOnly: true, class: "read", operation: "bigquery.jobs.query", owner: "C" }),
  entry("plan", {
    kind: "tool",
    readOnly: true,
    class: "read",
    operation: "bigquery.jobs.insert",
    resourceKind: "any",
    owner: "D",
    note: "Dry-runs a change and returns a preview and a single-use plan; changes nothing",
  }),
  entry("events_list", { kind: "tool", readOnly: true, class: "read", operation: "bigquery.jobs.list", owner: "E" }),
  entry("saved_read", { kind: "tool", readOnly: true, class: "read", operation: "bigquery.jobs.query", owner: "E" }),
  entry("save", {
    kind: "tool",
    readOnly: false,
    class: "export",
    operation: "bigquery.jobs.getQueryResults",
    savable: true,
    owner: "E",
    note: "Writes a finished query's results to a local file",
  }),
  entry("cancel", { kind: "tool", readOnly: false, class: "write", operation: "bigquery.jobs.cancel", savable: true, owner: "D" }),
  entry("write", { kind: "tool", readOnly: false, class: "write", operation: "bigquery.jobs.insert", commits: "write", savable: true, owner: "D" }),
  entry("export", { kind: "tool", readOnly: false, class: "export", operation: "bigquery.jobs.insert", commits: "export", savable: true, owner: "D" }),
  entry("share", { kind: "tool", readOnly: false, class: "write", operation: "bigquery.jobs.insert", commits: "share", savable: true, owner: "D" }),
  entry("delete", {
    kind: "tool",
    readOnly: false,
    class: "destructive",
    operation: "bigquery.jobs.insert",
    commits: "delete",
    savable: false,
    owner: "D",
    note: "Commits a delete plan: deletes rows, tables or datasets, replaces objects, runs scripts and procedures",
  }),
  entry("admin", { kind: "tool", readOnly: false, class: "write", operation: "bigquery.jobs.insert", commits: "admin", savable: true, owner: "D" }),
  entry("saved_list", {
    kind: "method",
    readOnly: true,
    class: "read",
    operation: "bigquery.jobs.queryEstimate",
    owner: "E",
    note: "Lists your saved queries with their SQL and estimates, for a source's set-up; reads no data",
  }),
  entry("probe", {
    kind: "method",
    readOnly: true,
    class: "read",
    operation: "local",
    owner: "E",
    note: "Names the signed-in account for sources; makes no BigQuery call",
  }),
]

/**
 * Permission-only reads: actions no tool is named for, asserted by a tool besides its own. `bigquery.read` is the source
 * contract's operation rule: a source's read asserts it on each `<account>:<operation>` it uses (contract L1, "a dotted
 * operation … is asserted as `<namespace>.read`"), so a person's off switch for one operation is consulted. Declared
 * read-only and allowed at every access, as every read is.
 */
export const PERMISSION_ONLY: readonly { readonly action: string; readonly readOnly: true; readonly owner: Package; readonly note: string }[] = [
  { action: `${NAMESPACE}.read`, readOnly: true, owner: "E", note: "Reads the BigQuery metadata and data a source you bound names; never changes anything" },
]

/** The source contract's per-operation read action (contract L1). */
export const SOURCE_READ = PERMISSION_ONLY[0]!.action

/** The run-time asks: actions a tool asserts at run time, declared in the package's `asks`. Whether one asks is the rules'. */
export const ASKS = {
  /** `bigquery_query({ planId })` asserts it before running a read the byte cap cannot bound. */
  uncappedRead: `${NAMESPACE}.uncapped_read`,
} as const

export const TOOLS = ACTIONS.filter((item) => item.kind === "tool")
export const READ_ACTIONS = ACTIONS.filter((item) => item.readOnly)
export const CHANGE_ACTIONS = ACTIONS.filter((item) => !item.readOnly)
/** The tools RPC's methods: every read, tools and method-only entries alike. A change is never a method. */
export const RPC_METHODS = ACTIONS.filter((item) => item.readOnly && item.class === "read")

/** Every action the plugin may assert: the entries' actions, the permission-only reads and the run-time asks. */
export const ASSERTABLE: ReadonlySet<string> = new Set([...ACTIONS.map((item) => item.action), ...PERMISSION_ONLY.map((item) => item.action), ...Object.values(ASKS)])

/** The tool that commits a category. */
export const COMMIT_TOOL: Readonly<Record<Category, string>> = {
  "uncapped-read": `${NAMESPACE}_query`,
  write: `${NAMESPACE}_write`,
  export: `${NAMESPACE}_export`,
  share: `${NAMESPACE}_share`,
  delete: `${NAMESPACE}_delete`,
  admin: `${NAMESPACE}_admin`,
}

export function actionOf(name: string): ActionEntry {
  const found = ACTIONS.find((item) => item.name === name)
  if (!found) throw new Error(`no action is declared for ${name}`)
  return found
}
