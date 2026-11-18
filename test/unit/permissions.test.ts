import { describe, expect, it } from "vitest"
import { ACCESS_VALUES } from "../../src/constants.js"
import { ACTIONS, ASKS } from "../../src/domain/actions.js"
import { changeEffect, defaultRules, effectOf, insertDefaults, registerPermissionDefaults, type Rule, unguardedAgents } from "../../src/permissions.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }

describe("default rules", () => {
  it("give a change the access effect: allow, ask, deny", () => {
    expect(ACCESS_VALUES.map(changeEffect)).toEqual(["allow", "ask", "deny"])
  })

  it("allow every read at every access, so reads run at Read only", () => {
    for (const access of ACCESS_VALUES) {
      const rules = [BASE, ...defaultRules(access)]
      for (const entry of ACTIONS.filter((item) => item.readOnly)) expect(effectOf(rules, entry.action), `${access} ${entry.name}`).toBe("allow")
    }
  })

  it("give the five commits, save and cancel the change effect", () => {
    const changes = ACTIONS.filter((item) => !item.readOnly).map((item) => item.name)
    expect(changes).toEqual(["save", "cancel", "write", "export", "share", "delete", "admin"])
    for (const access of ACCESS_VALUES) {
      const rules = [BASE, ...defaultRules(access)]
      for (const name of changes) expect(effectOf(rules, `bigquery.${name}`), `${access} ${name}`).toBe(changeEffect(access))
    }
  })

  it("ask for an uncapped read at all and ask-changes, and deny it at read-only", () => {
    expect(ACCESS_VALUES.map((access) => effectOf([BASE, ...defaultRules(access)], ASKS.uncappedRead))).toEqual(["ask", "ask", "deny"])
  })

  it("allow the source contract's per-operation read, bigquery.read, at every access, on any operation", () => {
    for (const access of ACCESS_VALUES) expect(effectOf([BASE, ...defaultRules(access)], "bigquery.read", "work:bigquery.jobs.list"), access).toBe("allow")
  })

  it("treat an action the plugin does not declare like a change, at every access", () => {
    for (const access of ACCESS_VALUES) expect(effectOf([BASE, ...defaultRules(access)], "bigquery.never_seen"), access).toBe(changeEffect(access))
  })

  it("start with the broad bigquery.* rule, and leave other plugins' tools alone", () => {
    for (const access of ACCESS_VALUES) expect(defaultRules(access)[0]).toEqual({ action: "bigquery.*", resource: "*", effect: changeEffect(access) })
    expect(defaultRules("read-only").every((rule) => rule.action.startsWith("bigquery."))).toBe(true)
  })
})

describe("insertion", () => {
  const rules = defaultRules("ask-changes")

  it("goes right after the agent's base * * allow", () => {
    const before: Rule[] = [{ action: "bash", resource: "*", effect: "ask" }, BASE, { action: "edit", resource: "*", effect: "deny" }]
    const after = insertDefaults(before, rules)
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2))
    expect(after.slice(2, 2 + rules.length)).toEqual(rules)
    expect(after.at(-1)).toEqual(before.at(-1))
  })

  it("is not repeated, and skips an agent without a base allow", () => {
    const once = insertDefaults([BASE], rules)
    expect(insertDefaults(once, rules)).toEqual(once)
    const strict: Rule[] = [{ action: "*", resource: "*", effect: "ask" }]
    expect(insertDefaults(strict, rules)).toEqual(strict)
  })

  it("names the agents that miss the block and would run a new tool unasked", () => {
    const agents = [
      { id: "build", permissions: insertDefaults([BASE], defaultRules("all")) },
      { id: "mine", permissions: [BASE] },
      { id: "careful", permissions: [BASE, { action: "bigquery.*", resource: "*", effect: "deny" } as Rule] },
    ]
    expect(unguardedAgents(agents, "all")).toEqual(["mine"])
  })

  it("never throws from the transform; a failure is reported", async () => {
    const reports: (string | undefined)[] = []
    const ctx = {
      agent: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({ list: () => { throw new Error("broken host") }, update: () => undefined })
          return { dispose: async () => undefined }
        },
      },
    }
    await registerPermissionDefaults(ctx as never, "all", (problem) => reports.push(problem))
    expect(reports[0]).toMatch(/^RULES_NOT_ADDED: .* Next step: Restart OpenCode\.$/)
  })
})
