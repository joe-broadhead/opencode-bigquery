// The jelly declaration against Jelly's own contract at master, and Jelly's access rules simulated at all three levels.
// Jelly's source is private, so this runs only where JELLY_SRC names an export of it (`git archive` of jelly's
// origin/HEAD, never an edited clone): JELLY_SRC=<dir> bun test ./test/conformance/jelly-master.test.ts. Elsewhere it
// is skipped. The simulation re-implements backend/host/src/connections/plugin-access.ts `accessRules` and
// plugin-asks.ts `withPluginAsks` over the contract's own `effectOfAccess` and `pluginToolScope`.
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ACTIONS, ASKS, PERMISSION_ONLY } from "../../src/domain/actions.js"

const SRC = process.env.JELLY_SRC
const contracts = SRC ? join(SRC, "protocol/contracts/src") : ""
const present = SRC !== undefined && existsSync(join(contracts, "plugin-contract.ts"))
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { jelly: Record<string, unknown>; sources: unknown }

type Effect = "allow" | "ask" | "deny"
const wild = (value: string, pattern: string) =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value)

test.skipIf(!present)("validates against Jelly's PluginDeclarationSchema at master", async () => {
  const { PluginDeclarationSchema, unknownDeclarationFields } = await import(join(contracts, "plugin-contract.ts"))
  const { SourcesDeclarationSchema } = await import(join(contracts, "source-contract.ts"))
  const parsed = PluginDeclarationSchema.safeParse(pkg.jelly)
  expect(parsed.success ? "ok" : parsed.error.issues).toBe("ok")
  expect(unknownDeclarationFields(pkg.jelly)).toEqual([])
  expect(PluginDeclarationSchema.safeParse({ ...pkg.jelly, sources: pkg.sources }).success).toBe(true)
  expect(SourcesDeclarationSchema.safeParse(pkg.sources).success).toBe(true)
  expect(parsed.data.asks).toEqual([ASKS.uncappedRead])
})

test.skipIf(!present)("Jelly's access rules: reads run at every level, changes follow the choice, the ask asks where Jelly asks", async () => {
  const { PluginDeclarationSchema } = await import(join(contracts, "plugin-contract.ts"))
  const { effectOfAccess } = await import(join(contracts, "plugin-access.light.ts"))
  const { pluginToolScope } = await import(join(contracts, "plugin-tools.light.ts"))
  const declaration = PluginDeclarationSchema.parse(pkg.jelly)
  const decide = (access: "all" | "ask-changes" | "read-only", action: string): Effect => {
    const namespace: Effect = access === "all" ? "allow" : access === "read-only" ? "deny" : "ask"
    const patterns = pluginToolScope(declaration).flatMap((entry: string) => [`${entry}.*`, `${entry}_*`])
    const rules: { action: string; effect: Effect; access: boolean }[] = [
      ...patterns.map((pattern: string) => ({ action: pattern, effect: namespace, access: true })),
      ...declaration.tools.map((tool: { permission: string; readOnly?: boolean; effect: Effect }) => ({ action: tool.permission, effect: effectOfAccess(access, tool.readOnly === true, tool.effect) as Effect, access: false })),
    ]
    const evaluate = (list: typeof rules) => list.findLast((rule) => wild(action, rule.action))?.effect ?? "allow"
    let effect = evaluate(rules)
    // withPluginAsks: only where the person chose Ask before changes or Read only (D165); an access pattern's deny
    // never silences a declared ask (D77), another rule's deny stands.
    if (access !== "all" && (declaration.asks ?? []).includes(action) && effect !== "ask") {
      if (evaluate(rules.filter((rule) => !rule.access)) !== "deny") effect = "ask"
    }
    return effect
  }
  const table: Record<string, Record<string, Effect>> = {}
  for (const access of ["all", "ask-changes", "read-only"] as const) {
    table[access] = Object.fromEntries([...ACTIONS.map((entry) => entry.action), ...PERMISSION_ONLY.map((entry) => entry.action), ASKS.uncappedRead, "bigquery.undeclared_tool"].map((action) => [action, decide(access, action)]))
  }
  for (const entry of ACTIONS) {
    expect([table.all![entry.action], table["ask-changes"]![entry.action], table["read-only"]![entry.action]], entry.action).toEqual(
      entry.readOnly ? ["allow", "allow", "allow"] : ["allow", "ask", "deny"],
    )
  }
  // The source contract's per-operation read is a read: allowed at every level.
  for (const entry of PERMISSION_ONLY) {
    expect([table.all![entry.action], table["ask-changes"]![entry.action], table["read-only"]![entry.action]], entry.action).toEqual(["allow", "allow", "allow"])
  }
  expect([table.all![ASKS.uncappedRead], table["ask-changes"]![ASKS.uncappedRead], table["read-only"]![ASKS.uncappedRead]]).toEqual(["allow", "ask", "ask"])
  expect([table.all!["bigquery.undeclared_tool"], table["ask-changes"]!["bigquery.undeclared_tool"], table["read-only"]!["bigquery.undeclared_tool"]]).toEqual(["allow", "ask", "deny"])
  console.log(JSON.stringify(table, null, 1))
})

test.skipIf(present)("skipped: JELLY_SRC does not name an export of jelly's source", () => {
  expect(present).toBe(false)
})
