// The built plugin in an embedded OpenCode host. Nothing leaves the machine: close() fails the test if the host tried.
import { afterAll, describe, expect, test } from "bun:test"
import { TOOLS } from "../../src/domain/actions.js"
import type { ToolName } from "../../src/domain/contract.js"
import { defaultRules } from "../../src/permissions.js"
import { HANDLERS } from "../../src/registry.js"
import { isStatus } from "../../src/rpc.js"
import { agentRules, cleanup, pluginState, startHost, status } from "./harness.js"

afterAll(cleanup)

describe("the plugin in a host", () => {
  test("loads, inserts the default rules and answers status with no request off the machine", async () => {
    const host = await startHost()
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      const rules = (await agentRules(host)).get("build") ?? []
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(rules.slice(base + 1, base + 1 + defaultRules("all").length)).toEqual(defaultRules("all"))
      const answer = await status(host)
      expect(isStatus(answer)).toBe(true)
      // The nineteen tools are registered; those no package has built yet answer NOT_BUILT.
      expect(answer).toMatchObject({ access: "all", unguardedAgents: [], tools: { registered: 19, notBuilt: TOOLS.filter((entry) => HANDLERS[entry.name as ToolName] === undefined).length } })
    } finally {
      await host.close()
    }
  }, 120_000)

  test("generates the block for ask-changes", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const rules = (await agentRules(host)).get("build") ?? []
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(rules.slice(base + 1, base + 1 + defaultRules("ask-changes").length)).toEqual(defaultRules("ask-changes"))
      expect((await status(host)).access).toBe("ask-changes")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("refuses an unknown option, and a host outside the range", async () => {
    const typo = await startHost({ options: { acess: "all" } })
    try {
      expect(await pluginState(typo)).toMatchObject({ status: "failed", error: expect.stringContaining("OPTIONS_INVALID") })
    } finally {
      await typo.close()
    }
    const old = await startHost({ version: "2.1.0" })
    try {
      expect(await pluginState(old)).toMatchObject({ status: "failed", error: expect.stringContaining("HOST_UNTESTED") })
    } finally {
      await old.close()
    }
  }, 240_000)
})
