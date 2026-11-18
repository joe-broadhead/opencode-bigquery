import { describe, expect, it } from "vitest"
import { ACTIONS, ASKS } from "../../src/domain/actions.js"
import { ALL_SCOPES, DISCLOSURE } from "../../src/domain/levels.js"
import { loadOptions } from "../../src/options.js"
import { defaultRules } from "../../src/permissions.js"
import { toolSpecs } from "../../src/registry.js"
import { SKILL_IDS } from "../../src/skills.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, lineProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingChoices, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"
import { fakePorts } from "../fake/ports.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. The shared kit checks it against
 * Jelly's plugin authors' standard; the tests below add what only BigQuery declares. Jelly's agents have no base
 * "allow everything" rule, so the plugin's own default rules never reach them; Jelly's own access rules decide there
 * (test/conformance/jelly-master.test.ts simulates them against Jelly's own contract when it is at hand).
 */

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
type SignIn = { id: string; label: string; integration: string; scopes: string[]; account: { description: string; option: string }; needed: string[] }
const jelly = manifest.jelly as Declaration & { asks: string[]; rpc: unknown[]; views: unknown[]; signIns: SignIn[]; contributes: Record<string, unknown[]> & { settings: PluginSetting[] }; tools: DeclaredTool[] }

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const registered = toolSpecs(loadOptions({}), fakePorts()).map((spec) => spec.action)
    expect(declarationProblems(ROOT, { effectOf: effectFromRules(defaultRules()), actionPermissions: true, registered })).toEqual([])
  })

  it("declares exactly the action table: every action the plugin asserts, each read read-only", () => {
    expect(jelly.tools).toEqual(
      ACTIONS.map((entry) => ({ name: entry.action, permission: entry.action, effect: "allow", readOnly: entry.readOnly, ...(entry.note ? { note: entry.note } : {}) })),
    )
    expect(jelly.tools).toHaveLength(21)
    expect(jelly.tools.filter((tool) => tool.readOnly)).toHaveLength(14)
  })

  it("declares the one run-time ask, the uncapped read, and says on the card what Jelly does with it at each level", () => {
    expect(jelly.asks).toEqual([ASKS.uncappedRead])
    // Under Allowed Jelly runs a declared ask without asking (D165), so the card must not promise a prompt there.
    const note = jelly.tools.find((tool) => tool.name === "bigquery.query")!.note!
    expect(note).toContain("under Allowed without asking")
    expect(note).toContain("120 seconds")
    expect(note).toContain("otherwise you are asked first")
  })

  it("declares the skills the plugin registers", () => {
    expect(jelly.skills).toEqual([...SKILL_IDS])
  })

  it("declares one Google sign-in with every level's scopes and the disclosure", () => {
    expect(jelly.signIns).toHaveLength(1)
    const [signIn] = jelly.signIns
    expect(signIn).toMatchObject({ id: "google-bigquery", label: "Google Cloud (BigQuery)", integration: "bigquery-*", needed: ["AUTH_REQUIRED", "AUTH_SCOPE_MISSING"] })
    expect(signIn!.scopes).toEqual([...ALL_SCOPES])
    expect(signIn!.account.option).toBe("accounts")
    expect(signIn!.account.description).toContain(DISCLOSURE.bound)
    expect(signIn!.account.description.length).toBeLessThanOrEqual(500)
  })

  it("states the cost and the admin step in one line each", () => {
    expect(lineProblems("cost", jelly.cost, 300)).toEqual([])
    expect(lineProblems("admin", jelly.admin, 200)).toEqual([])
    expect(jelly.cost).toMatch(/\$6\.25 per TiB/)
    expect(jelly.cost).toMatch(/AI\/ML functions, Python UDFs and remote functions bill outside that cap/)
    // The saved source's price conditions, held out of the sources block (test/conformance/declaration.test.ts).
    expect(jelly.cost).toMatch(/on demand/)
    expect(jelly.cost).toMatch(/cached reads are free/)
    expect(jelly.cost).toMatch(/a saved query 1 GiB a read/)
  })

  it("declares no views or RPC methods, and access as its one setting", () => {
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
    expect(jelly.contributes.settings.map((setting) => setting.key)).toEqual(["access"])
    expect(settingsProblems(jelly.contributes.settings)).toEqual([])
  })

  it("access declares Jelly's own words, and the parser takes each value and refuses others", () => {
    const access = jelly.contributes.settings.find((setting) => setting.key === "access")!
    expect(access.choices).toEqual(ACCESS_CHOICES)
    expect(access.default).toBe(loadOptions({}).access)
    for (const { value } of settingChoices(access) ?? []) expect<string>(loadOptions({ access: value }).access).toBe(value)
    expect(settingValueIssue(access, "write")).not.toBeNull()
    expect(() => loadOptions({ access: "write" })).toThrow(/OPTIONS_INVALID/)
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
