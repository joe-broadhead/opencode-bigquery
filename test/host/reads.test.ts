// Package C's host suite: the built plugin in stock OpenCode with the eight read tools wired, called the way a person's
// rules and a model's tool call reach them. Nothing leaves the machine: `close()` fails the test if it did.
import { afterAll, describe, expect, test } from "bun:test"
import { cleanup, pluginState, startHost, status } from "./harness.js"

afterAll(cleanup)

/** A live tool by the name OpenCode gives it, from the probe plugin's context. */
async function liveTool(host: Awaited<ReturnType<typeof startHost>>, suffix: string) {
  const tools = await host.probe().tool.list()
  const found = tools.find((tool) => tool.id === `bigquery.${suffix}` || tool.id === `bigquery_${suffix}` || tool.id.endsWith(`.${suffix}`))
  if (!found) throw new Error(`no live tool for ${suffix}; ids: ${tools.map((tool) => tool.id).join(", ")}`)
  return found
}

/** A real session, because the host checks one on every permission assert. */
async function session(host: Awaited<ReturnType<typeof startHost>>): Promise<string> {
  const created = (await host.client.sessions.create({ title: "reads host", agent: "build", location: { directory: host.location.directory } })) as { id?: string }
  const id = created.id ?? (created as unknown as { data: { id: string } }).data.id
  if (!id) throw new Error("the host did not create a session")
  return id
}

const invocation = (sessionID: string) => ({
  sessionID,
  agent: "build",
  messageID: "msg_host_1",
  id: "call_host_1",
  signal: new AbortController().signal,
  progress: async () => undefined,
})

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

  test("a person's deny rule on the operation stops a read before any request (design §5.4, review M-2)", async () => {
    const host = await startHost({
      options: { accounts: { default: { billingProject: "invented-proj", location: "US" } } },
      config: () => ({ permissions: [{ action: "bigquery.list", resource: "default:bigquery.projects.list", effect: "deny" }] }),
    })
    try {
      const tool = await liveTool(host, "list")
      // A denial from the host's rules reaches the caller; nothing was sent, and `close()` proves nothing left.
      const denied = await tool.execute({}, invocation(await session(host)) as never).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(denied).toBeDefined()
      expect(String(denied)).toMatch(/Permission denied: bigquery\.list/i)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a read the rules allow reaches the registry's assert and the unbuilt ports, not the network", async () => {
    const host = await startHost({ options: { accounts: { default: { billingProject: "invented-proj", location: "US" } } } })
    try {
      const tool = await liveTool(host, "list")
      const outcome = (await tool.execute({}, invocation(await session(host)) as never)) as { output?: Record<string, unknown> }
      // No package has built the BigQuery port yet, so the registry's guarded port answers NOT_BUILT.
      expect(JSON.stringify(outcome.output ?? outcome)).toContain("NOT_BUILT")
    } finally {
      await host.close()
    }
  }, 120_000)
})
