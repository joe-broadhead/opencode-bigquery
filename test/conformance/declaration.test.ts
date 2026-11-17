// The `sources` block in package.json, checked by the source contract's own validators (v0.2.0, from its built dist):
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
