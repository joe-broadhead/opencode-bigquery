// Package E's host suite: the built plugin in stock OpenCode, called the way a script and a model call it. The only
// requests the host may make are to this file's loopback fake, which serves Google's two hosts in Google's own shapes
// (a full-projection `bigquery#jobList`, a `Job`, a `getQueryResults` answer, token-info); `close()` fails the test if
// anything else left the machine.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Rpc } from "@opencode/plugin/rpc"
import { RPC_METHODS } from "../../src/domain/actions.js"
import { TOOLS_RPC_ID } from "../../src/host/script-methods.js"
import { jobResource } from "../unit/sources/support.js"
import { pluginState, startHost, status, type Host } from "./harness.js"
import { ROOT } from "./isolate.js"
import { routeFetch } from "./route-fetch.js"

// The host suite's files share one process, and an earlier file's afterAll removes the scratch root and restores the
// harness's fetch router. This file therefore makes the scratch root and the current folder again, and installs its own
// router, so it runs the same whatever order Bun loads the files in. Every request it makes still goes to its fake; the
// router's blocked list is checked below, and `close()` checks the harness's.
const router = routeFetch()

beforeAll(() => {
  // Recreate what an earlier file's cleanup removed: the scratch root, its HOME and TMPDIR, and the current folder.
  for (const dir of [ROOT, join(ROOT, "home"), join(ROOT, "tmp")]) mkdirSync(dir, { recursive: true })
  process.chdir(ROOT)
})

afterAll(() => {
  cleanup()
  router.restore()
})

/** The harness's cleanup, without importing its afterAll twice. */
function cleanup() {
  if (router.blocked.length > 0) throw new Error(`the sources host test tried to leave the machine: ${[...new Set(router.blocked)].join(", ")}`)
}

/** The client side only names the methods: the plugin checks each input against its own contract. */
const open = {}
const Tools = Rpc.define({
  id: TOOLS_RPC_ID,
  methods: Object.fromEntries(["describe", ...RPC_METHODS.map((entry) => entry.name)].map((name) => [name, { input: open, output: open, errors: { failed: open } }])),
  events: {},
})

const TOKEN = "invented-host-access-token"
const NOW = Date.now()
const PROJECT = "invented-proj"

/** The job the fake lists and saves: a finished SELECT, as `jobs.list` and `jobs.get` return it. */
const job = jobResource({ jobId: "job-1", created: NOW - 3_600_000, ended: NOW - 3_500_000, statementType: "SELECT", bytesBilled: 1_048_576 })

/** Google's error body, so the runtime maps a status the way Google's reference describes it. */
const googleError = (code: number, reason: string, message: string) => Response.json({ error: { code, message, status: reason.toUpperCase(), errors: [{ reason, message }] } }, { status: code })

/**
 * A loopback fake of bigquery.googleapis.com and oauth2.googleapis.com: token-info, `jobs.list`, `jobs.get` and
 * `getQueryResults`, with the query parameters the source must send. Anything else is 404 in Google's error shape.
 */
function fake() {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/tokeninfo") {
        return Response.json({ email: "ada@example.invalid", email_verified: true, scope: "https://www.googleapis.com/auth/bigquery" })
      }
      if (request.method === "GET" && url.pathname === `/bigquery/v2/projects/${PROJECT}/jobs`) {
        // `jobs.list` as the reference describes it: a creation-time window, one state, newest first. The one job is
        // DONE; nothing is queued or running. Bun's answer carries an HTTP Date, Google's clock to the source.
        const state = url.searchParams.get("stateFilter")
        if (state !== "DONE" && state !== "PENDING" && state !== "RUNNING") return googleError(400, "invalid", "stateFilter must be a job state")
        if (url.searchParams.get("allUsers") !== "false") return googleError(400, "invalid", "allUsers must be false")
        const min = url.searchParams.get("minCreationTime")
        const max = url.searchParams.get("maxCreationTime")
        if (min !== null && max !== null && Number(max) < Number(min)) return googleError(400, "invalid", "an empty window")
        return Response.json({ kind: "bigquery#jobList", etag: "invented", jobs: state === "DONE" ? [job] : [] })
      }
      if (request.method === "GET" && url.pathname === `/bigquery/v2/projects/${PROJECT}/jobs/job-1`) {
        return Response.json(job)
      }
      if (request.method === "GET" && url.pathname === `/bigquery/v2/projects/${PROJECT}/queries/job-1`) {
        return Response.json({
          kind: "bigquery#getQueryResultsResponse",
          jobReference: { projectId: PROJECT, jobId: "job-1", location: "US" },
          jobComplete: true,
          schema: { fields: [{ name: "id", type: "INT64", mode: "NULLABLE" }, { name: "note", type: "STRING", mode: "NULLABLE" }] },
          rows: [{ f: [{ v: "1" }, { v: "one" }] }, { f: [{ v: "2" }, { v: "two" }] }],
          totalRows: "2",
        })
      }
      return googleError(404, "notFound", "not found")
    },
  })
  return { origin: `http://127.0.0.1:${server.port}`, close: async () => void server.stop(true) }
}

/** A host whose Google hosts (and token-info) our router sends to a fresh fake. */
async function started(options: Record<string, unknown>) {
  const loopback = fake()
  router.target = loopback.origin
  return startHost({ options, fake: loopback })
}

async function session(host: Host): Promise<string> {
  const created = (await host.client.sessions.create({ title: "sources host", agent: "build", location: { directory: host.location.directory } })) as { id?: string }
  const id = created.id ?? (created as unknown as { data: { id: string } }).data.id
  if (!id) throw new Error("the host did not create a session")
  return id
}

async function liveTool(host: Host, suffix: string) {
  const tools = await host.probe().tool.list()
  const found = tools.find((tool) => tool.id === `bigquery.${suffix}` || tool.id === `bigquery_${suffix}` || tool.id.endsWith(`.${suffix}`))
  if (!found) throw new Error(`no live tool for ${suffix}; ids: ${tools.map((tool) => tool.id).join(", ")}`)
  return found
}

const invocation = (sessionID: string) => ({
  sessionID,
  agent: "build",
  messageID: "msg_sources_host",
  id: "call_sources_host",
  signal: new AbortController().signal,
  progress: async () => undefined,
})

const options = {
  accounts: { work: { mode: "token", tokenEnv: "BQ_HOST_TOKEN", billingProject: PROJECT, location: "US" } },
  savedQueries: { revenue: { sql: "SELECT id FROM sales.orders" } },
}

beforeAll(() => {
  process.env.BQ_HOST_TOKEN = TOKEN
})
afterAll(() => {
  delete process.env.BQ_HOST_TOKEN
})

describe("the sources in a host", () => {
  test("loads with the source tools built, serves the tools RPC's reads, and names the sign-in at probe", async () => {
    const host = await started(options)
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      expect((await status(host)).tools.notBuilt).toBeLessThanOrEqual(8)
      const tools = host.probe().rpc(Tools) as unknown as Record<string, (input: unknown, options?: unknown) => Promise<unknown>>
      const described = (await tools.describe!({ sessionID: await session(host) })) as { methods: { name: string }[] }
      const names = described.methods.map((method) => method.name)
      for (const name of ["events_list", "saved_read", "saved_list", "probe"]) expect(names).toContain(name)

      // probe reads the sign-in through package A's real token-mode port; the fake answers Google's token-info. A
      // consumer sends the item's `input.source` with the account (source-contract L2), for each source.
      for (const source of ["jobs", "saved"]) {
        const probed = (await tools.probe!({ sessionID: await session(host), input: { source, account: "work" } })) as Record<string, unknown>
        expect(probed).toMatchObject({ source, account: "work", owner: { id: "mailto:ada@example.invalid" }, trust: "untrusted" })
      }
      // The bind step's suggest call, as the contract's reader makes it: the source's id and the account.
      const suggested = (await tools.saved_list!({ sessionID: await session(host), input: { source: "bigquery.saved", account: "work" } })) as Record<string, unknown>
      expect(suggested["options"]).toEqual([{ id: "revenue", label: "revenue: SELECT id FROM sales.orders" }])
      const page = (await tools.events_list!({ sessionID: await session(host), input: { source: "jobs", account: "work" } })) as Record<string, unknown>
      expect(page).toMatchObject({ source: "jobs", account: "work", owner: { id: "mailto:ada@example.invalid" }, trust: "untrusted", more: false })
      expect((page["events"] as { external_id: string }[]).map((event) => event.external_id)).toEqual(["invented-proj:US:job-1"])
    } finally {
      await host.close()
    }
  }, 120_000)

  test("the model's tool answers the same page, and bigquery_save writes the job's rows to the project", async () => {
    const host = await started(options)
    const file = join(host.location.directory, `host-save-${Date.now().toString(36)}.csv`)
    try {
      const events = await liveTool(host, "events_list")
      const page = (await events.execute({ source: "jobs", account: "work" }, invocation(await session(host)) as never)) as { output?: Record<string, unknown> }
      expect((page.output?.["events"] as { title: string }[])[0]?.title).toContain("SELECT")

      const save = await liveTool(host, "save")
      const answer = (await save.execute({ project: PROJECT, jobId: "job-1", location: "US", path: file, format: "csv" }, invocation(await session(host)) as never)) as {
        output?: Record<string, unknown>
      }
      // The project is under the system's /tmp, a link on macOS (/private/tmp): the answer is the file's real path.
      expect(answer.output).toMatchObject({ state: "done", path: realpathSync(file), rows: 2, charts: { format: "csv", rows: 2, fitsCharts: true } })
      expect(readFileSync(file, "utf8")).toBe("id,note\r\n1,one\r\n2,two\r\n")
    } finally {
      if (existsSync(file)) rmSync(file, { force: true })
      await host.close()
    }
  }, 120_000)

  test("bigquery_save refuses a path outside the project before any Google call", async () => {
    const host = await started(options)
    try {
      const tool = await liveTool(host, "save")
      const answer = (await tool.execute({ project: PROJECT, jobId: "job-1", path: "/etc/outside-the-project.csv", format: "csv" }, invocation(await session(host)) as never)) as {
        output?: Record<string, unknown>
      }
      expect(answer.output?.["error"]).toBe("SAVE_PATH_REFUSED")
    } finally {
      await host.close()
    }
  }, 120_000)
})
