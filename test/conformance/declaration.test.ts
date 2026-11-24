// The `sources` block in package.json, checked by the source contract's own validators (v0.3.0, from its built dist):
// `checkSources`, `declarationProblems` and `assertDeclaration` with the registry's tools RPC methods, every one
// read-only. The conformance kit's run over the methods (paging, gaps, refusals) is package E's (test/conformance/run).
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { assertDeclaration, declarationProblems, operationProblem } from "@we-the-rebel-alliance/source-contract/conformance"
import { checkSources } from "@we-the-rebel-alliance/source-contract/descriptor"
import { ACTIONS } from "../../src/domain/actions.js"
import { TOOLS_RPC_ID } from "../../src/host/script-methods.js"
import { loadOptions } from "../../src/options.js"
import { toolSpecs } from "../../src/registry.js"
import { fakePorts } from "../fake/ports.js"

type Item = { id: string; tool: string; permission: { tool?: string; events?: string; operations: string[] }; scope?: { suggest?: { tool: string; operations: string[] } } }
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  sources: { rpc: string; probe: { action: string }; items: Item[] }
}
const sources = pkg.sources
const methods = toolSpecs(loadOptions({}), fakePorts()).filter((spec) => spec.class === "read" && spec.readOnly)
const tools = methods.map((spec) => ({ id: spec.name, readOnly: spec.readOnly }))

test("passes the source contract's validator and its declaration rules", () => {
  const checked = checkSources(sources)
  expect(checked.ok ? "ok" : checked).toBe("ok")
  expect(declarationProblems(sources, { tools })).toEqual([])
  expect(() => assertDeclaration(sources, { tools })).not.toThrow()
})

test("names the plugin's tools RPC, and methods that exist and are reads", () => {
  expect(sources.rpc).toBe(TOOLS_RPC_ID)
  const names = new Set(methods.map((spec) => spec.name))
  for (const item of sources.items) {
    expect(names.has(item.tool), item.id).toBe(true)
    if (item.scope?.suggest) expect(names.has(item.scope.suggest.tool), item.id).toBe(true)
  }
  expect(names.has("probe")).toBe(true)
})

test("asserts actions the action table declares, read-only", () => {
  const declared = new Map(ACTIONS.map((entry) => [entry.action, entry.readOnly]))
  const actions = [sources.probe.action, ...sources.items.map((item) => item.permission.tool ?? item.permission.events!)]
  for (const action of actions) expect(declared.get(action), action).toBe(true)
  for (const item of sources.items) expect(methods.find((spec) => spec.name === item.tool)?.action).toBe(item.permission.tool ?? item.permission.events)
})

test("names only read operations, as the resolvers do", () => {
  for (const item of sources.items) for (const operation of [...item.permission.operations, ...(item.scope?.suggest?.operations ?? [])]) expect(operationProblem(operation), operation).toBeUndefined()
  for (const spec of methods.filter((each) => each.resource && each.resourceKind !== "any")) {
    const operation = spec.resource!({})!.split(":")[1]!
    expect(operationProblem(operation), `${spec.name}: ${operation}`).toBeUndefined()
  }
})

/**
 * Keys source-contract v0.1.x consumers refuse outright. The plugin holds them until those consumers re-vendor
 * v0.2.0; this test keeps one from coming back by accident. Delete an entry here only when that lands, and say so in
 * the CHANGELOG.
 */
const HELD_ANYWHERE = ["removals", "identityRules", "readsIdentity", "verified", "conditions", "min"] as const

function heldKeys(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => heldKeys(item, `${path}[${index}]`))
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const here = `${path}.${key}`
    const found: string[] = []
    if ((HELD_ANYWHERE as readonly string[]).includes(key)) found.push(here)
    if (key === "accounts" && typeof child === "object" && child !== null && "server" in child) found.push(`${here}.server`)
    if (key === "permission" && typeof child === "object" && child !== null && Array.isArray((child as { identity?: unknown }).identity) && (child as { identity: unknown[] }).identity.length === 0) {
      found.push(`${here}.identity (empty)`)
    }
    return [...found, ...heldKeys(child, here)]
  })
}

test("declares none of the keys v0.1.x consumers refuse, until they read v0.2.0", () => {
  expect(heldKeys(sources, "sources")).toEqual([])
})

test("the held-key check finds each held key", () => {
  const planted = {
    items: [
      { accounts: { server: "x" }, permission: { identity: [] }, identityRules: [], readsIdentity: true, cost: { units: [{ per: "tib", usd: 1, min: 0, conditions: "x" }] } },
      { removals: [], owner: { verified: false } },
    ],
  }
  expect(heldKeys(planted, "s").sort()).toEqual(
    [
      "s.items[0].accounts.server",
      "s.items[0].permission.identity (empty)",
      "s.items[0].identityRules",
      "s.items[0].readsIdentity",
      "s.items[0].cost.units[0].min",
      "s.items[0].cost.units[0].conditions",
      "s.items[1].removals",
      "s.items[1].owner.verified",
    ].sort(),
  )
})

test("keeps every billed price honest on its own: a unit and a dollar amount above zero", () => {
  for (const item of sources.items as unknown as { id: string; cost: { class: string; units?: { per?: string; usd?: number }[] } }[]) {
    if (item.cost.class !== "billed") continue
    expect(item.cost.units?.length, item.id).toBeGreaterThan(0)
    for (const unit of item.cost.units ?? []) {
      expect(typeof unit.per, item.id).toBe("string")
      expect(unit.usd, item.id).toBeGreaterThan(0)
    }
  }
  const saved = (sources.items as unknown as { id: string; cost: unknown }[]).find((item) => item.id === "bigquery.saved")!
  expect(saved.cost).toEqual({ class: "billed", units: [{ per: "tib", usd: 6.25 }], probe: { per: "call", usd: 0 } })
})
