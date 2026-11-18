// Package D's host suite (design §14.3 "access"): the built plugin in stock OpenCode, with the seven change tools wired,
// their default rules per `access`, and the assert that comes before any request. Nothing leaves the machine: `close()`
// fails the test if it did.
import { afterAll, describe, expect, test } from "bun:test"
import { effectOf, type Rule } from "../../src/permissions.js"
import { agentRules, cleanup, pluginState, startHost, status } from "./harness.js"

afterAll(cleanup)

const CHANGES = ["bigquery.write", "bigquery.export", "bigquery.share", "bigquery.delete", "bigquery.admin", "bigquery.cancel"] as const

/** A live tool by the name OpenCode gives it, from the probe plugin's context. */
async function liveTool(host: Awaited<ReturnType<typeof startHost>>, suffix: string) {
  const tools = await host.probe().tool.list()
  const found = tools.find((tool) => tool.id === `bigquery.${suffix}` || tool.id === `bigquery_${suffix}` || tool.id.endsWith(`.${suffix}`))
  if (!found) throw new Error(`no live tool for ${suffix}; ids: ${tools.map((tool) => tool.id).join(", ")}`)
  return found
}

/** A real session, because the host checks one on every permission assert. */
async function session(host: Awaited<ReturnType<typeof startHost>>): Promise<string> {
  const created = (await host.client.sessions.create({ title: "changes host", agent: "build", location: { directory: host.location.directory } })) as { id?: string }
  const id = created.id ?? (created as unknown as { data: { id: string } }).data.id
  if (!id) throw new Error("the host did not create a session")
  return id
}

/** Options with one account, so a request gets as far as package B's unbuilt port. */
const ACCOUNT_OPTIONS = (access: string) => ({ access, accounts: { default: { billingProject: "invented-proj", location: "US" } } })

const invocation = (sessionID: string) => ({
  sessionID,
  agent: "build",
  messageID: "msg_host_changes_1",
  id: "call_host_changes_1",
  signal: new AbortController().signal,
  progress: async () => undefined,
})

/** The default rules the agent got, once the plugin has added its block. */
async function rules(host: Awaited<ReturnType<typeof startHost>>): Promise<readonly Rule[]> {
  const all = await agentRules(host)
  return all.get("build") ?? []
}

/** Runs a tool and returns its error, or undefined when it answered. */
const failed = (run: Promise<unknown>) => run.then(() => undefined, (error: unknown) => error)

describe("the change tools' default rules per access (design §5.2, §14.3)", () => {
  test("access all: every change is allowed, the plan is a read, and the seven handlers are built", async () => {
    const host = await startHost({ options: ACCOUNT_OPTIONS("all") })
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      const answer = await status(host)
      expect(answer.tools.registered).toBe(19)
      // D built seven of the nineteen; E and F still answer NOT_BUILT.
      expect(answer.tools.notBuilt).toBeLessThanOrEqual(4)
      expect(answer.unguardedAgents).toEqual([])
      const found = await rules(host)
      expect(effectOf(found, "bigquery.plan")).toBe("allow")
      for (const action of CHANGES) expect(effectOf(found, action), action).toBe("allow")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("access ask-changes: the plan is still a read, and every change asks", async () => {
    const host = await startHost({ options: ACCOUNT_OPTIONS("ask-changes") })
    try {
      const found = await rules(host)
      expect(effectOf(found, "bigquery.plan")).toBe("allow")
      for (const action of CHANGES) expect(effectOf(found, action), action).toBe("ask")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("access read-only: the plan still previews, and no change runs", async () => {
    const host = await startHost({ options: ACCOUNT_OPTIONS("read-only") })
    try {
      const found = await rules(host)
      expect(effectOf(found, "bigquery.plan")).toBe("allow")
      for (const action of CHANGES) expect(effectOf(found, action), action).toBe("deny")
    } finally {
      await host.close()
    }
  }, 120_000)
})

describe("the assert comes before any request", () => {
  test("a person's deny rule stops the plan and the cancel before either reaches a port", async () => {
    const host = await startHost({
      options: ACCOUNT_OPTIONS("all"),
      config: () => ({
        permissions: [
          { action: "bigquery.plan", resource: "default:bigquery.jobs.insert", effect: "deny" },
          { action: "bigquery.cancel", resource: "default:bigquery.jobs.cancel", effect: "deny" },
        ],
      }),
    })
    try {
      const sessionID = await session(host)
      const plan = await liveTool(host, "plan")
      const planned = await failed(plan.execute({ sql: "INSERT INTO `invented-proj.sales.orders` (id) VALUES (1)" }, invocation(sessionID) as never))
      expect(String(planned)).toMatch(/Permission denied: bigquery\.plan/i)

      const cancel = await liveTool(host, "cancel")
      const cancelled = await failed(cancel.execute({ project: "invented-proj", jobId: "oc_invented_job", location: "US" }, invocation(sessionID) as never))
      expect(String(cancelled)).toMatch(/Permission denied: bigquery\.cancel/i)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("an allowed plan, cancel and commit reach the plugin's own code and stop at the sign-in, never the network", async () => {
    const host = await startHost({ options: ACCOUNT_OPTIONS("all") })
    try {
      const sessionID = await session(host)
      // The rules allowed them (the deny case above shows the same asserts refusing), so each reached package B's
      // runtime, which finds no sign-in and answers before any request; `close()` proves none left the machine.
      const plan = await liveTool(host, "plan")
      const planned = (await plan.execute({ sql: "INSERT INTO `invented-proj.sales.orders` (id) VALUES (1)" }, invocation(sessionID) as never)) as { output?: Record<string, unknown> }
      expect(planned.output).toMatchObject({ state: "refused", error: "AUTH_REQUIRED" })

      const cancel = await liveTool(host, "cancel")
      const cancelled = (await cancel.execute({ project: "invented-proj", jobId: "oc_invented_job", location: "US" }, invocation(sessionID) as never)) as { output?: Record<string, unknown> }
      expect(cancelled.output).toMatchObject({ state: "refused", error: "AUTH_REQUIRED" })

      // A commit with no plan refuses from the plan store, before any port: nothing runs without a plan.
      for (const name of ["write", "export", "share", "delete", "admin"]) {
        const tool = await liveTool(host, name)
        const answer = (await tool.execute({ planId: "plan_never_made_anywhere_abc" }, invocation(sessionID) as never)) as { output?: Record<string, unknown> }
        expect(answer.output?.error, name).toBe("PLAN_NOT_FOUND")
      }
    } finally {
      await host.close()
    }
  }, 120_000)
})
