// The status the command and the TUI read (`computeStatus`, `src/rpc.ts`): the family's rows plus BigQuery's own —
// accounts, fences, caps, budget and what the ledger says was billed today — with no request to Google.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { loadOptions } from "../../../src/options.js"
import { formatStatus, isStatus, STATUS_SCHEMA, statusRows, type Status } from "../../../src/rpc.js"
import { computeStatus, type StatusDeps } from "../../../src/status.js"

/** The parsed options the plugin passes to `registerStatus` (and so to `computeStatus`). */
const deps = (options?: StatusDeps["options"]): StatusDeps => ({
  access: "all",
  hostVersion: "2.2.3",
  tools: () => ({ registered: 19, notBuilt: 1 }),
  skills: [],
  problems: () => [],
  ...(options !== undefined ? { options } : {}),
})

/** The parts of OpenCode's context `computeStatus` reads. */
const context = () =>
  ({
    agent: { list: async () => ({ data: [] }) },
    skill: { list: async () => ({ data: [] }) },
  }) as unknown as Parameters<typeof computeStatus>[0]

const row = (status: Status, label: string) => statusRows(status).find((entry) => entry.label === label)?.value

const dirs: string[] = []
const tempState = (): string => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bq-status-rpc-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.XDG_STATE_HOME
})

describe("the status the command and the TUI read", () => {
  it("adds BigQuery's accounts, fence, caps and the day's billed bytes from the ledger, and nothing off the machine", async () => {
    const state = tempState()
    process.env.XDG_STATE_HOME = state
    mkdirSync(join(state, "opencode-bigquery"), { recursive: true })
    writeFileSync(
      join(state, "opencode-bigquery", "spend.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), account: "default", project: "invented-proj", location: "US", jobId: "oc_one", bytesBilled: 2 ** 30, via: "bigquery_query", session: "0123456789abcdef" })}\n`,
    )
    const options = loadOptions({
      accounts: { default: { billingProject: "invented-proj", location: "US", datasets: { allow: ["invented-proj.sales"], deny: ["invented-proj.secret"] } } },
      maxBytesBilled: "10GiB",
      maxBytesCeiling: "100GiB",
      budget: { daily: "2GiB", action: "refuse" },
    })
    const status = await computeStatus(context(), deps(options))
    expect(isStatus(status)).toBe(true)
    expect(row(status, "Accounts")).toBe("default (interactive) · invented-proj · US")
    expect(row(status, "Dataset fence")).toBe("default: allow invented-proj.sales; deny invented-proj.secret")
    expect(row(status, "Byte cap")).toBe("10 GiB per job by default, up to 100 GiB · budget: 2 GiB a day, refuse")
    expect(row(status, "Billed today")).toBe("1 GiB ($0.01)")
    // BigQuery's rows sit after the family's and before the next step, in both the dialog and the command's text.
    const labels = statusRows(status).map((entry) => entry.label)
    expect(labels.slice(0, 4)).toEqual(["Access", "Tools", "Agents without default rules", "Accounts"])
    expect(labels.at(-1)).toBe("Next step")
    expect(formatStatus(status)).toContain("Billed today: 1 GiB ($0.01)")
  })

  it("carries no BigQuery rows when the host did not hand over the options", async () => {
    const status = await computeStatus(context(), deps())
    expect(isStatus(status)).toBe(true)
    expect(status.details).toBeUndefined()
    expect(statusRows(status).map((entry) => entry.label)).toEqual(["Access", "Tools", "Agents without default rules", "OpenCode", "Next step"])
  })

  it("rejects a details row that is not a label and a value", () => {
    const base = { version: "0.0.1", access: "all", tools: { registered: 19, notBuilt: 1 }, unguardedAgents: [], host: { version: "2.2.3", range: ">=2.2.3 <2.4.0", tested: true }, nextStep: "Nothing to do." }
    expect(isStatus({ ...base, details: [{ label: "Accounts", value: "default" }] })).toBe(true)
    expect(isStatus({ ...base, details: [{ label: "Accounts" }] })).toBe(false)
    expect(isStatus({ ...base, details: [{ label: "Accounts", value: "default", extra: true }] })).toBe(false)
    expect((STATUS_SCHEMA.properties as Record<string, unknown>).details).toBeDefined()
  })
})
