// Package F's host suite: the built plugin in stock OpenCode with `bigquery_status` wired, the /bigquery-status command
// registered and the status RPC the TUI reads. Nothing leaves the machine: `close()` fails the test if it did.
import { afterAll, describe, expect, test } from "bun:test"
import { isStatus } from "../../src/rpc.js"
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
  const created = (await host.client.sessions.create({ title: "status host", agent: "build", location: { directory: host.location.directory } })) as { id?: string }
  const id = created.id ?? (created as unknown as { data: { id: string } }).data.id
  if (!id) throw new Error("the host did not create a session")
  return id
}

const invocation = (sessionID: string) => ({
  sessionID,
  agent: "build",
  messageID: "msg_host_status_1",
  id: "call_host_status_1",
  signal: new AbortController().signal,
  progress: async () => undefined,
})

describe("status in a host", () => {
  test("registers /bigquery-status and answers the status tool and the status RPC with no request off the machine", async () => {
    const host = await startHost({ options: { accounts: { default: { billingProject: "invented-proj", location: "US" } } } })
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      const commands = (await host.probe().command.list()) as unknown as { data?: { name: string }[] } | { name: string }[]
      const names = (Array.isArray(commands) ? commands : (commands.data ?? [])).map((command) => command.name)
      expect(names).toContain("bigquery-status")

      // The tool: a default interactive account with no sign-in answers read, with the sign-in's next step, and never
      // reaches the network — the auth port refuses before any request, and close() records any that escaped.
      const tool = await liveTool(host, "status")
      const outcome = (await tool.execute({}, invocation(await session(host)) as never)) as { output?: Record<string, unknown> }
      const answer = JSON.parse(JSON.stringify(outcome.output ?? outcome)) as Record<string, unknown>
      expect(answer).toMatchObject({
        state: "done",
        accounts: [{ alias: "default", mode: "interactive", level: "read", billingProject: "invented-proj", location: "US" }],
        caps: { maxBytesBilled: 10 * 2 ** 30, maxBytesCeiling: 100 * 2 ** 30 },
        spend: { todayBytes: 0, sessionBytes: 0, todayUsd: 0 },
      })
      expect(String(answer.next)).toContain("/connect")

      // The command and the TUI read the same facts through the status RPC; BigQuery's own rows come from the options
      // and the local ledger, so they appear even before any sign-in.
      const rpc = await status(host)
      expect(isStatus(rpc)).toBe(true)
      expect(rpc.details).toBeDefined()
      expect(rpc.details!.map((row) => row.label)).toEqual(["Accounts", "Byte cap", "Billed today"])
      expect(rpc.details![0]!.value).toBe("default (interactive) · invented-proj · US")
    } finally {
      await host.close()
    }
  }, 180_000)

  test("a person's deny rule stops the status before it runs", async () => {
    const host = await startHost({
      options: { accounts: { default: { billingProject: "invented-proj" } } },
      config: () => ({ permissions: [{ action: "bigquery.status", resource: "*", effect: "deny" }] }),
    })
    try {
      const tool = await liveTool(host, "status")
      const denied = await tool.execute({}, invocation(await session(host)) as never).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(denied).toBeDefined()
      expect(String(denied)).toMatch(/Permission denied: bigquery\.status/i)
    } finally {
      await host.close()
    }
  }, 180_000)
})
