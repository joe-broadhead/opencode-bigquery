// Default permission rules for BigQuery's tools, inserted into each agent right after its base `* * allow` rule.
// OpenCode applies the last matching rule, so the agent's own stricter rules (Plan, Explore), the user's `permissions`
// rules and saved approvals all still win. The `access` option generates the block.
import type { Plugin } from "@opencode/plugin"
import { type Access, NAMESPACE } from "./constants.js"
import { errorText } from "./domain/errors.js"
import { reasonOf } from "./redact.js"

export type Effect = "allow" | "ask" | "deny"
export type Rule = { readonly action: string; readonly resource: string; readonly effect: Effect }

/** The plugin's namespace as an action pattern: a tool a later release adds has an action under it too. */
export const NAMESPACE_ACTION = `${NAMESPACE}.*`

/** What a change gets at each access. */
export function changeEffect(access: Access): Effect {
  return access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
}

/**
 * Broad first, narrow last, because the last matching rule wins. The namespace rule gives every action the change
 * effect, so an action the plugin has not declared is treated like a change. TODO(Day 0): one rule per declared action.
 */
export function defaultRules(access: Access = "all"): Rule[] {
  return [{ action: NAMESPACE_ACTION, resource: "*", effect: changeEffect(access) }]
}

const isBaseAllow = (item: Rule) => item.action === "*" && item.resource === "*" && item.effect === "allow"
const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect

/**
 * Inserts `defaults` right after the first base allow rule, unless the block is already somewhere after it (other
 * plugins insert at the same place). Agents without one are unchanged.
 */
export function insertDefaults<R extends Rule>(rules: readonly R[], defaults: readonly R[]): R[] {
  const base = rules.findIndex(isBaseAllow)
  if (base === -1 || hasBlockAfter(rules, base, defaults)) return [...rules]
  return [...rules.slice(0, base + 1), ...defaults.map((item) => ({ ...item })), ...rules.slice(base + 1)]
}

/** An action the plugin does not know: what an agent's rules do for it shows whether a new tool would run unasked. */
const UNKNOWN_ACTION = `${NAMESPACE}.unknown_tool`

/**
 * Agents without the default block whose own rules would let an unknown BigQuery action run without asking. OpenCode
 * creates agents defined only in the user's config after plugins run, so they never receive the block.
 */
export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all"): string[] {
  const defaults = defaultRules(access)
  return agents
    .filter((agent) => !hasBlockAfter(agent.permissions, agent.permissions.findIndex(isBaseAllow), defaults))
    .filter((agent) => effectOf(agent.permissions, UNKNOWN_ACTION) === "allow")
    .map((agent) => agent.id)
}

/** OpenCode's wildcards: `*` matches any run of characters and `?` one character, over the whole text. */
export const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** The effect of `rules` for one call: the last rule whose action and resource both match wins, and no match asks. */
export function effectOf(rules: readonly Rule[], action: string, resource = "*"): Effect {
  return rules.findLast((item) => matches(item.action, action) && matches(item.resource, resource))?.effect ?? "ask"
}

function hasBlockAfter(rules: readonly Rule[], base: number, defaults: readonly Rule[]): boolean {
  if (base === -1) return false
  for (let start = base + 1; start + defaults.length <= rules.length; start++) {
    if (defaults.every((item, index) => rules[start + index] !== undefined && same(rules[start + index]!, item))) return true
  }
  return false
}

type AgentContext = { readonly agent: Pick<Plugin.Context["agent"], "transform"> }

/** Registers the default rules for every agent. Synchronous and never throws; a failure is kept for status. */
export async function registerPermissionDefaults(
  ctx: AgentContext,
  access: Access,
  report: (problem: string | undefined) => void,
): Promise<{ dispose(): Promise<void> }> {
  const defaults = defaultRules(access)
  return ctx.agent.transform((editor) => {
    try {
      for (const agent of editor.list()) {
        editor.update(agent.id, (item) => {
          item.permissions = insertDefaults(item.permissions, defaults)
        })
      }
      report(undefined)
    } catch (error) {
      report(errorText("RULES_NOT_ADDED", `The default permission rules could not be added (${reasonOf(error)})`))
    }
  })
}
