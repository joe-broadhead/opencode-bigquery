// The status contract shared by the server part, the /bigquery-status command and the TUI view. Portable and small: it
// imports only the RPC definition helper and constants, and the contract is plain JSON Schema, so the TUI bundle
// carries no zod. The TypeScript type is written out by hand, and isStatus checks a value against the same rules.
import { Rpc } from "@opencode/plugin/rpc"
import { ACCESS_VALUES, type Access, DISPLAY_NAME, NAMESPACE, PLUGIN_ID } from "./constants.js"

const EFFECTS = ["allow", "ask", "deny"] as const

export type Rule = { readonly action: string; readonly resource: string; readonly effect: (typeof EFFECTS)[number] }
export type SkillPath = { readonly id: string; readonly path: string }

/** In the order the dialog and /bigquery-status show it. version, host, unguardedAgents and nextStep are the shared fields. */
export type Status = {
  readonly version: string
  readonly access: Access
  /** The plugin's tools: how many are registered, and how many still answer that they are not built yet. */
  readonly tools: { readonly registered: number; readonly notBuilt: number }
  readonly unguardedAgents: readonly string[]
  readonly permissionsBlock?: readonly Rule[]
  readonly shadowedSkills?: readonly SkillPath[]
  /** Registration problems, each `CODE: what. Next step: what.` Present only when there are any. */
  readonly problems?: readonly string[]
  readonly host: { readonly version: string; readonly range: string; readonly tested: boolean }
  readonly hostWarning?: string
  /**
   * BigQuery's own rows, formatted by the server part (`src/status.ts`) from the options and the local spend ledger:
   * the accounts, the dataset fence, the byte caps and what was billed today. No request to Google.
   */
  readonly details?: readonly StatusRow[]
  readonly nextStep: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const count = { type: "integer", minimum: 0 } as const
const object = (properties: Record<string, object>, required: readonly string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const rule = object({ action: text, resource: text, effect: { enum: EFFECTS } }, ["action", "resource", "effect"])
const skillPath = object({ id: text, path: text }, ["id", "path"])
/** One labelled row of BigQuery's own status (`Status.details`). */
export type StatusRow = { readonly label: string; readonly value: string }
const statusRow = object({ label: text, value: text }, ["label", "value"])

export const STATUS_SCHEMA = object(
  {
    version: text,
    access: { enum: ACCESS_VALUES },
    tools: object({ registered: count, notBuilt: count }, ["registered", "notBuilt"]),
    unguardedAgents: texts,
    permissionsBlock: { type: "array", items: rule },
    shadowedSkills: { type: "array", items: skillPath },
    problems: texts,
    host: object({ version: text, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    hostWarning: text,
    details: { type: "array", items: statusRow },
    nextStep: text,
  },
  ["version", "access", "tools", "unguardedAgents", "host", "nextStep"],
)

export const BigQueryRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    status: {
      input: object({}, []),
      output: STATUS_SCHEMA,
      errors: { unavailable: object({ reason: text }, ["reason"]) },
    },
  },
  events: {},
})

type Record_ = Record<string, unknown>
const isRecord = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === "string"
const isTexts = (value: unknown) => Array.isArray(value) && value.every(isText)
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0
const only = (value: Record_, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const isRule = (value: unknown) =>
  isRecord(value) && only(value, ["action", "resource", "effect"]) && isText(value.action) && isText(value.resource) && EFFECTS.includes(value.effect as never)
const isSkillPath = (value: unknown) => isRecord(value) && only(value, ["id", "path"]) && isText(value.id) && isText(value.path)
const isStatusRow = (value: unknown) => isRecord(value) && only(value, ["label", "value"]) && isText(value.label) && isText(value.value)

/** JSON Schema outputs reach clients unchecked, so readers check a status against the schema's rules. */
export function isStatus(value: unknown): value is Status {
  if (!isRecord(value) || !only(value, Object.keys(STATUS_SCHEMA.properties))) return false
  const { tools, host } = value
  return (
    isText(value.version) &&
    ACCESS_VALUES.includes(value.access as never) &&
    isRecord(tools) && only(tools, ["registered", "notBuilt"]) && isCount(tools.registered) && isCount(tools.notBuilt) &&
    isTexts(value.unguardedAgents) &&
    optional(value.permissionsBlock, (block) => Array.isArray(block) && block.every(isRule)) &&
    optional(value.shadowedSkills, (skills) => Array.isArray(skills) && skills.every(isSkillPath)) &&
    optional(value.problems, isTexts) &&
    isRecord(host) && only(host, ["version", "range", "tested"]) && isText(host.version) && isText(host.range) && typeof host.tested === "boolean" &&
    optional(value.hostWarning, isText) &&
    optional(value.details, (rows) => Array.isArray(rows) && rows.every(isStatusRow)) &&
    isText(value.nextStep)
  )
}

export const NOTHING_TO_DO = "Nothing to do."
export const STATUS_COMMAND = `${NAMESPACE}-status`

/** The next step for agents without the default rules: one fixed sentence across the plugins, with no names. */
export const AGENT_STEP = `Put the default rules shown by /${STATUS_COMMAND} first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for ${DISPLAY_NAME} tools.`

const NONE = "none"

export function formatRules(rules: readonly Rule[]): string {
  return `[\n${rules.map((item) => `  ${JSON.stringify(item)}`).join(",\n")}\n]`
}

const ACCESS_TEXT: Record<Access, string> = {
  all: "every tool runs without asking, changes included",
  "ask-changes": "reads run without asking; every commit, save and cancel asks first",
  "read-only": "reads run without asking; every commit, save and cancel is denied",
}

function describeTools(tools: Status["tools"]): string {
  if (tools.registered === 0) return "none yet"
  return tools.notBuilt === 0 ? `${tools.registered} registered` : `${tools.registered} registered, ${tools.notBuilt} not built yet`
}

function describeHost(status: Pick<Status, "host" | "hostWarning">): string {
  if (status.host.tested) return `${status.host.version} (tested)`
  if (status.hostWarning) return `${status.host.version} (untested: ${status.hostWarning})`
  return `${status.host.version} (untested; supported range ${status.host.range})`
}

/** The status as labelled rows, in the order the dialog and /bigquery-status show them. */
export function statusRows(status: Status): StatusRow[] {
  return [
    { label: "Access", value: ACCESS_TEXT[status.access] },
    { label: "Tools", value: describeTools(status.tools) },
    { label: "Agents without default rules", value: status.unguardedAgents.length > 0 ? status.unguardedAgents.join(", ") : NONE },
    ...(status.shadowedSkills?.length ? [{ label: "Skills", value: status.shadowedSkills.map((skill) => `${skill.id} replaced by ${skill.path}`).join("; ") }] : []),
    ...(status.problems?.length ? [{ label: "Problems", value: status.problems.join(" ") }] : []),
    ...(status.details ?? []),
    { label: "OpenCode", value: describeHost(status) },
    { label: "Next step", value: status.nextStep },
  ]
}

const STATUS_TITLE = `${DISPLAY_NAME} status`

export function formatStatus(status: Status): string {
  const lines: string[] = [STATUS_TITLE]
  for (const row of statusRows(status)) {
    lines.push(`${row.label}: ${row.value}`)
    if (row.label === "Agents without default rules" && status.unguardedAgents.length > 0) lines.push(formatRules(status.permissionsBlock ?? []))
  }
  return lines.join("\n")
}
