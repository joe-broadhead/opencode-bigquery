import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/options.js"
import { defaultRules } from "../../src/permissions.js"
import { SKILL_IDS } from "../../src/skills.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, lineProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingChoices, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. The shared kit checks it against
 * Jelly's plugin authors' standard; the tests below add what only BigQuery declares.
 */

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
const jelly = manifest.jelly as Declaration & { rpc: unknown[]; views: unknown[]; contributes: Record<string, unknown[]> & { settings: PluginSetting[] }; tools: DeclaredTool[] }

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const problems = declarationProblems(ROOT, { effectOf: effectFromRules(defaultRules()), actionPermissions: true })
    // TODO(Day 0): the tools are declared with the contract; then this is [].
    expect(problems).toEqual(jelly.tools.length === 0 ? ["jelly.tools is empty"] : [])
  })

  it("declares the skills the plugin registers", () => {
    expect(jelly.skills).toEqual([...SKILL_IDS])
  })

  it("states the cost and the admin step in one line each", () => {
    expect(lineProblems("cost", jelly.cost, 300)).toEqual([])
    expect(lineProblems("admin", jelly.admin, 200)).toEqual([])
    expect(jelly.cost).toMatch(/\$6\.25 per TiB/)
    expect(jelly.cost).toMatch(/AI\/ML functions, Python UDFs and remote functions bill outside that cap/)
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
