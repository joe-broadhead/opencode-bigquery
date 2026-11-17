// Package C's host suite: the built plugin in stock OpenCode with the eight read tools wired, and status counted from
// the registry. Everything a read does before Google can be asserted here; the guards, asserts and refusals are the
// unit suites' subject (`test/unit/reads`, `test/unit/guards`), and the host-level read calls join these when package
// B's fake Google server lands (`test/fake/bigquery.ts`). Nothing leaves the machine: `close()` fails the test if it did.
import { afterAll, describe, expect, test } from "bun:test"
import { cleanup, pluginState, startHost, status } from "./harness.js"

afterAll(cleanup)

describe("the read tools in a host", () => {
  test("loads with a read account, counts the eight read tools as built, and makes no request off the machine", async () => {
    const host = await startHost({ options: { accounts: { default: { billingProject: "invented-proj", location: "US" } } } })
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      const answer = await status(host)
      expect(answer.access).toBe("all")
      expect(answer.tools.registered).toBe(19)
      // Package C built eight of the nineteen; the rest answer NOT_BUILT until their packages land.
      expect(answer.tools.notBuilt).toBeLessThanOrEqual(11)
      expect(answer.unguardedAgents).toEqual([])
    } finally {
      await host.close()
    }
  }, 120_000)
})
